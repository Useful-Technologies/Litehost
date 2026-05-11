const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const cgroup = require('./cgroup');

const processes = new Map();
const PORT_START = 4000;
const PORT_END = 5000;

// ─── Cached prepared statements ──────────────────────────────────────────────
const stmts = {
  getUsedPorts: db.prepare('SELECT port FROM sites WHERE port IS NOT NULL'),
  getSitePort:  db.prepare('SELECT port FROM sites WHERE id = ?'),
  getSiteName:  db.prepare('SELECT name FROM sites WHERE id = ?'),
  setRunning:   db.prepare("UPDATE sites SET status = 'running' WHERE id = ?"),
  setStopped:   db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?"),
  setError:     db.prepare("UPDATE sites SET status = 'error' WHERE id = ?"),
  getRunning:   db.prepare("SELECT * FROM sites WHERE runtime IN ('node', 'custom', 'worker') AND status = 'running'"),
};

function getUsedPorts() {
  return new Set(stmts.getUsedPorts.all().map(s => s.port));
}

function isPortListening(port) {
  try {
    execSync(`ss -tlnp | grep ':${port} '`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Return the PID listening on a port, or null if not found.
function getPortPid(port) {
  try {
    const out = execSync(`ss -tlnp sport = :${port}`, { stdio: 'pipe' }).toString();
    const match = out.match(/pid=(\d+)/);
    return match ? parseInt(match[1]) : null;
  } catch {
    return null;
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
  // Worker runtime: {PORT} is optional
  if (site.runtime !== 'worker' && !site.start_command.includes('{PORT}')) {
    throw new Error('start_command must contain {PORT} placeholder');
  }
  if (site.port) {
    return site.start_command.replace(/{PORT}/g, String(site.port));
  }
  return site.start_command;
}

function parseEnv(jsonStr) {
  try { return JSON.parse(jsonStr || '{}'); } catch { return {}; }
}

function logLine(fd, msg) {
  const ts = new Date().toISOString();
  fs.writeSync(fd, `[${ts}] ${msg}\n`);
}

// ─── Resolve uid/gid from a Linux username ────────────────────────────────────
// Uses the `id` command — fast, always accurate, no native addon needed.
// Returns { uid: number, gid: number } or null if the user doesn't exist.
function resolveUser(username) {
  if (!username) return null;
  try {
    const uid = parseInt(execSync(`id -u ${username}`, { stdio: 'pipe' }).toString().trim());
    const gid = parseInt(execSync(`id -g ${username}`, { stdio: 'pipe' }).toString().trim());
    if (isNaN(uid) || isNaN(gid)) return null;
    return { uid, gid };
  } catch {
    return null;
  }
}

// ─── startSite ────────────────────────────────────────────────────────────────
function startSite(site) {
  const siteDir = `/opt/hosted-sites/${site.name}`;
  const logFile = `/var/log/hostctl/${site.name}.log`;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(siteDir, { recursive: true });

  const cmd = buildCommand(site);

  const fd = fs.openSync(logFile, 'a');
  logLine(fd, `[START] ${cmd}`);

  // Resolve per-site user if isolation is set up; fall back to litehost
  const userInfo = site.sys_user ? resolveUser(site.sys_user) : null;

  const siteEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: siteDir,
    USER: site.sys_user || 'litehost',
    ...parseEnv(site.env_vars),
    ...(site.port ? { PORT: String(site.port) } : {}),
  };

  // Ensure cgroup exists for this site (idempotent)
  cgroup.createCgroup(site.name, site.mem_limit_mb || null, site.cpu_quota_pct || null);

  const spawnOpts = {
    cwd: siteDir,
    env: siteEnv,
    detached: true,
    stdio: ['ignore', fd, fd],
  };

  // Spawn as the site-specific user when available (requires CAP_SETUID/SETGID
  // granted via AmbientCapabilities in litehost.service)
  if (userInfo) {
    spawnOpts.uid = userInfo.uid;
    spawnOpts.gid = userInfo.gid;
  }

  let proc;
  try {
    proc = spawn('/bin/sh', ['-c', cmd], spawnOpts);
  } catch (err) {
    logLine(fd, `[ERROR] spawn failed: ${err.message}`);
    try { fs.closeSync(fd); } catch {}
    stmts.setError.run(site.id);
    throw err;
  }

  // Place the process (and all its future children) into the site's cgroup
  // immediately after spawn.  The tiny race window is covered by the
  // cgroup.kill fallback in stopSite().
  cgroup.addToCgroup(site.name, proc.pid);
  logLine(fd, `[CGROUP] pid ${proc.pid} → site-${site.name}`);

  proc.on('error', (err) => {
    logLine(fd, `[ERROR] ${err.message}`);
    try { fs.closeSync(fd); } catch {}
    stmts.setError.run(site.id);
    processes.delete(site.id);
  });

  proc.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    logLine(fd, `[EXIT] Process exited with ${reason}`);
    try { fs.closeSync(fd); } catch {}
    stmts.setStopped.run(site.id);
    processes.delete(site.id);
  });

  processes.set(site.id, proc);
  stmts.setRunning.run(site.id);
  return proc.pid;
}

// ─── stopSite ─────────────────────────────────────────────────────────────────
function stopSite(siteId) {
  const row = stmts.getSiteName.get(siteId);
  const siteName = row?.name;

  // 1. Kill the tracked process's entire process group.
  //    spawn() uses detached:true so the child becomes a process group leader
  //    (PGID = child PID).  process.kill(-pid, 'SIGKILL') sends SIGKILL to
  //    every process in that group — master + all workers — in one shot.
  //    No sudo needed: all site processes run as the same user as the panel.
  const proc = processes.get(siteId);
  if (proc?.pid) {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {} // kill whole process group
    try { proc.kill('SIGKILL'); } catch {}               // belt-and-suspenders on parent
  }

  // 2. cgroup.kill — atomically kills any process in the cgroup regardless of
  //    UID.  Covers properly isolated sites (lh-* users) and survives fork tricks.
  if (siteName) {
    cgroup.killCgroup(siteName);
    cgroup.removeCgroup(siteName);
  }

  // 3. Port-based process group kill — handles recovered processes that are not
  //    in the Map.  getPortPid() finds the master listening on the port, which
  //    is the process group leader (gunicorn master, node, etc.).
  const site = stmts.getSitePort.get(siteId);
  if (site?.port) {
    const pid = getPortPid(site.port);
    if (pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch {} // kill whole group by port PID
      try { execSync(`pkill -KILL -P ${pid}`, { stdio: 'pipe' }); } catch {} // kill children
    }
    // Also sudo pkill by lh-* user for properly isolated sites
    if (siteName) {
      const sysUser = `lh-${siteName}`.slice(0, 31);
      try { execSync(`sudo pkill -KILL -u ${sysUser}`, { stdio: 'pipe' }); } catch {}
    }
  }

  processes.delete(siteId);
  stmts.setStopped.run(siteId);
}

function isRunning(siteId) {
  const proc = processes.get(siteId);
  return !!(proc && proc.exitCode === null && proc.signalCode === null);
}

// ─── recoverProcesses ─────────────────────────────────────────────────────────
// On panel restart: reconcile DB status with reality, restarting any sites
// that were running but whose process didn't survive the restart.
function recoverProcesses() {
  const sites = stmts.getRunning.all();

  for (const site of sites) {
    if (!site.port || !site.start_command) {
      stmts.setStopped.run(site.id);
      continue;
    }

    if (isPortListening(site.port)) {
      // Process survived — recreate cgroup and add the surviving PID so that
      // stopSite can kill it via cgroup.kill even though it's not in the Map.
      cgroup.createCgroup(site.name, site.mem_limit_mb || null, site.cpu_quota_pct || null);
      const pid = getPortPid(site.port);
      if (pid) {
        cgroup.addToCgroup(site.name, pid);
        console.log(`[pm] Site "${site.name}" still running (pid ${pid}) — added to cgroup`);
      } else {
        console.log(`[pm] Site "${site.name}" still running on port ${site.port}`);
      }
    } else {
      console.log(`[pm] Site "${site.name}" was running but process is gone — restarting…`);
      try {
        startSite(site);
        console.log(`[pm] Site "${site.name}" restarted successfully`);
      } catch (e) {
        console.error(`[pm] Failed to restart site "${site.name}": ${e.message}`);
        stmts.setStopped.run(site.id);
      }
    }
  }
}

// ─── getTrackedPids ───────────────────────────────────────────────────────────
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

module.exports = {
  startSite,
  stopSite,
  isRunning,
  findFreePort,
  buildCommand,
  recoverProcesses,
  getTrackedPids,
};
