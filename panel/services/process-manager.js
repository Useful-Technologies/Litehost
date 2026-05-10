const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const processes = new Map();
const PORT_START = 4000;
const PORT_END = 5000;

// ─── Process-tree kill ────────────────────────────────────────────────────────
// Walk /proc to find every descendant of rootPid, regardless of what process
// group each child is in.  Some frameworks (gunicorn workers, some Node cluster
// setups) call os.setpgrp() / setpgid(0,0) to leave the parent's process group,
// so process.kill(-pgid) only reaches processes that stayed in that group.
// PPid in /proc/<pid>/status is the ground truth for the actual parent—child
// relationship and cannot be faked.

function buildChildMap() {
  const childMap = new Map(); // ppid -> [pid, ...]
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return childMap; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
      const m = status.match(/^PPid:\s+(\d+)/m);
      if (!m) continue;
      const ppid = parseInt(m[1]);
      const pid  = parseInt(entry);
      if (!childMap.has(ppid)) childMap.set(ppid, []);
      childMap.get(ppid).push(pid);
    } catch {}
  }
  return childMap;
}

// Returns [rootPid, ...all descendants] in BFS order, reversed so that
// leaf processes are signalled first and the root last.
function collectTree(rootPid, childMap) {
  const result = [];
  const queue  = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    result.push(pid);
    for (const child of (childMap.get(pid) || [])) queue.push(child);
  }
  return result.reverse(); // leaves first, root last
}

function killTree(rootPid, signal = 'SIGTERM') {
  const childMap = buildChildMap();
  for (const pid of collectTree(rootPid, childMap)) {
    try { process.kill(pid, signal); } catch {}
  }
}

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
  // Kill the tracked process and every descendant.
  // killTree() walks /proc PPid entries so it catches workers that called
  // setpgrp() / setpgid(0,0) and escaped the original process group —
  // e.g. gunicorn workers, Node cluster children, etc.
  const proc = processes.get(siteId);
  if (proc) {
    killTree(proc.pid);
    processes.delete(siteId);
  }

  // Also kill by port — catches the port-holder for sites that outlived a
  // panel restart (recoverProcesses has no PID to walk from).
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
