const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const processes = new Map();
const PORT_START = 4000;
const PORT_END = 5000;

function getUsedPorts() {
  const sites = db.prepare('SELECT port FROM sites WHERE port IS NOT NULL').all();
  return new Set(sites.map(s => s.port));
}

function isPortListening(port) {
  try {
    execSync(`ss -tlnp | grep ':${port} '`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function findFreePort() {
  const used = getUsedPorts();
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (!used.has(p) && !isPortListening(p)) return p;
  }
  throw new Error('No free ports available in range 4000–5000');
}

function buildCommand(site) {
  if (!site.start_command) throw new Error('No start command defined');
  if (!site.start_command.includes('{PORT}')) {
    throw new Error('start_command must contain {PORT} placeholder');
  }
  return site.start_command.replace(/{PORT}/g, String(site.port));
}

function parseEnv(jsonStr) {
  try { return JSON.parse(jsonStr || '{}'); } catch { return {}; }
}

function logLine(fd, msg) {
  const ts = new Date().toISOString();
  fs.writeSync(fd, `[${ts}] ${msg}\n`);
}

function startSite(site) {
  const siteDir = `/opt/hosted-sites/${site.name}`;
  const logFile = `/var/log/hostctl/${site.name}.log`;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(siteDir, { recursive: true });

  const cmd = buildCommand(site);

  // Use a synchronous fd so it's ready before spawn — prevents early stderr being lost
  const fd = fs.openSync(logFile, 'a');
  logLine(fd, `[START] ${cmd}`);

  const siteEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: siteDir,
    USER: 'litehost',
    ...parseEnv(site.env_vars),
    PORT: String(site.port),
  };

  let proc;
  try {
    proc = spawn('/bin/sh', ['-c', cmd], {
      cwd: siteDir,
      env: siteEnv,
      // detached:true creates a new process group (PGID = proc.pid).
      // This lets stopSite send SIGTERM to the entire group — catches
      // gunicorn workers, Node cluster forks, and any other children.
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    // Don't unref — we keep monitoring via the 'exit' event.
  } catch (err) {
    // spawn() threw synchronously — close fd now, it will never be closed by an event
    logLine(fd, `[ERROR] spawn failed: ${err.message}`);
    try { fs.closeSync(fd); } catch {}
    db.prepare("UPDATE sites SET status = 'error' WHERE id = ?").run(site.id);
    throw err;
  }

  proc.on('error', (err) => {
    logLine(fd, `[ERROR] ${err.message}`);
    try { fs.closeSync(fd); } catch {}
    db.prepare("UPDATE sites SET status = 'error' WHERE id = ?").run(site.id);
    processes.delete(site.id);
  });

  proc.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    logLine(fd, `[EXIT] Process exited with ${reason}`);
    try { fs.closeSync(fd); } catch {}
    db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(site.id);
    processes.delete(site.id);
  });

  processes.set(site.id, proc);
  db.prepare("UPDATE sites SET status = 'running' WHERE id = ?").run(site.id);
  return proc.pid;
}

function stopSite(siteId) {
  // Kill tracked child process
  const proc = processes.get(siteId);
  if (proc) {
    try {
      // Negative PID = kill the entire process group.
      // Because we spawn with detached:true, proc.pid is the PGID leader,
      // so -proc.pid terminates the shell, the app, AND every forked worker
      // (gunicorn workers, Node cluster children, etc.) in one shot.
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      // Group already gone or permissions issue — fall back to direct kill
      try { proc.kill('SIGTERM'); } catch {}
    }
    processes.delete(siteId);
  }

  // Also kill by port — catches processes that outlived a panel restart
  // (recoverProcesses marks them running but can't track their PID/PGID)
  const site = db.prepare('SELECT port FROM sites WHERE id = ?').get(siteId);
  if (site?.port) {
    try { execSync(`fuser -k ${site.port}/tcp`, { stdio: 'pipe' }); } catch {}
  }

  db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(siteId);
}

function isRunning(siteId) {
  const proc = processes.get(siteId);
  return !!(proc && proc.exitCode === null && proc.signalCode === null);
}

// On panel restart: reconcile DB status with reality, restarting any
// sites that were running but whose process didn't survive the restart.
function recoverProcesses() {
  const sites = db.prepare(
    "SELECT * FROM sites WHERE runtime IN ('node', 'custom') AND status = 'running'"
  ).all();

  for (const site of sites) {
    if (!site.port || !site.start_command) {
      db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(site.id);
      continue;
    }

    if (isPortListening(site.port)) {
      // Process survived the panel restart (orphaned child, still running).
      // Keep it as-is — nothing to do.
      console.log(`[pm] Site "${site.name}" still running on port ${site.port}`);
    } else {
      // Process is gone — restart it automatically
      console.log(`[pm] Site "${site.name}" was running but process is gone — restarting…`);
      try {
        startSite(site);
        console.log(`[pm] Site "${site.name}" restarted successfully`);
      } catch (e) {
        console.error(`[pm] Failed to restart site "${site.name}": ${e.message}`);
        db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(site.id);
      }
    }
  }
}

// Return [{siteId, pid}] for every process currently tracked in the Map.
function getTrackedPids() {
  const out = [];
  for (const [siteId, proc] of processes) {
    if (proc && proc.pid && proc.exitCode === null && proc.signalCode === null) {
      out.push({ siteId, pid: proc.pid });
    }
  }
  return out;
}

module.exports = { startSite, stopSite, isRunning, findFreePort, buildCommand, recoverProcesses, getTrackedPids };
