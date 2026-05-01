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

function startSite(site) {
  const siteDir = `/opt/hosted-sites/${site.name}`;
  const logFile = `/var/log/hostctl/${site.name}.log`;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(siteDir, { recursive: true });

  const cmd = buildCommand(site);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const proc = spawn(parts[0], parts.slice(1), {
    cwd: siteDir,
    env: { ...process.env, ...parseEnv(site.env_vars), PORT: String(site.port) },
    detached: false,
    stdio: ['ignore', logStream, logStream],
  });

  proc.on('error', (err) => {
    logStream.write(`[ERROR] ${err.message}\n`);
    db.prepare("UPDATE sites SET status = 'error' WHERE id = ?").run(site.id);
    processes.delete(site.id);
  });

  proc.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    logStream.write(`[EXIT] Process exited with ${reason}\n`);
    db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(site.id);
    processes.delete(site.id);
  });

  processes.set(site.id, proc);
  db.prepare("UPDATE sites SET status = 'running' WHERE id = ?").run(site.id);
  return proc.pid;
}

function stopSite(siteId) {
  const proc = processes.get(siteId);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    processes.delete(siteId);
  }
  db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(siteId);
}

function isRunning(siteId) {
  const proc = processes.get(siteId);
  return !!(proc && proc.exitCode === null && proc.signalCode === null);
}

// On panel restart: reconcile DB status with reality.
// Sites marked 'running' that are no longer in our process map
// can't be recovered (we lost the PID), so mark them stopped.
// Sites with active port listeners get re-attached if possible.
function recoverProcesses() {
  const sites = db.prepare(
    "SELECT * FROM sites WHERE runtime IN ('node', 'custom') AND status = 'running'"
  ).all();

  for (const site of sites) {
    if (!site.port) {
      db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(site.id);
      continue;
    }

    if (isPortListening(site.port)) {
      // Something is listening on the port — likely survived a soft restart.
      // We can't attach to the process but mark it running so UI reflects reality.
      console.log(`[pm] Site "${site.name}" port ${site.port} already listening — keeping running status`);
    } else {
      // Port not listening, process is gone.
      db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(site.id);
      console.log(`[pm] Site "${site.name}" marked stopped (process gone)`);
    }
  }
}

module.exports = { startSite, stopSite, isRunning, findFreePort, buildCommand, recoverProcesses };
