/**
 * cgroup.js — cgroups v2 helpers for per-site isolation
 *
 * Prerequisites (set in litehost.service):
 *   Delegate=yes                          — systemd hands ownership of
 *                                           system.slice/litehost.service/ to
 *                                           the litehost user; no sudo needed
 *   AmbientCapabilities=CAP_SETUID CAP_SETGID — lets spawn() honour uid/gid
 *
 * All cgroup paths live under the litehost service's delegated subtree.
 * The path is auto-detected so it works whether the service is in
 * system.slice (default) or another slice.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Base path detection ──────────────────────────────────────────────────────
// Read /proc/self/cgroup to find the cgroup this process belongs to, then
// trim the final component (the service entry itself) to get the writable
// subtree root that systemd delegated to us.
//
// Expected format (cgroups v2 unified):
//   0::/system.slice/litehost.service
//
// We turn that into:
//   /sys/fs/cgroup/system.slice/litehost.service
//
// Falls back to a reasonable default if the file is missing (e.g. in tests).

function detectBase() {
  try {
    const raw = fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
    // Find the unified-hierarchy line (starts with "0::")
    const line = raw.split('\n').find(l => l.startsWith('0::'));
    if (line) {
      const rel = line.slice(3).trim(); // e.g. /system.slice/litehost.service
      return path.join('/sys/fs/cgroup', rel);
    }
  } catch {}
  return '/sys/fs/cgroup/system.slice/litehost.service';
}

const CGROUP_BASE = detectBase();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cgroupPath(siteName) {
  return path.join(CGROUP_BASE, `site-${siteName}`);
}

// Silently write a value to a cgroup control file.
function cgWrite(cgPath, file, value) {
  try { fs.writeFileSync(path.join(cgPath, file), String(value) + '\n'); } catch {}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create (or re-configure) a cgroup for a site.
 * Safe to call multiple times — mkdir is recursive + idempotent.
 *
 * @param {string}      siteName    Site slug (e.g. "myapp")
 * @param {number|null} memLimitMb  Memory cap in MB, or null for unlimited
 * @param {number|null} cpuQuotaPct CPU quota 1-100 (%), or null for unlimited
 */
function createCgroup(siteName, memLimitMb, cpuQuotaPct) {
  const cgPath = cgroupPath(siteName);
  try { fs.mkdirSync(cgPath, { recursive: true }); } catch {}

  // memory.high: soft limit — kernel throttles the cgroup when exceeded but
  // does NOT kill the process.  memory.max stays at "max" so there is no
  // hard OOM kill.
  cgWrite(cgPath, 'memory.high', memLimitMb ? memLimitMb * 1024 * 1024 : 'max');
  cgWrite(cgPath, 'memory.max',  'max');

  // cpu.max: "<quota_us> <period_us>" or "max <period_us>"
  if (cpuQuotaPct && cpuQuotaPct > 0 && cpuQuotaPct <= 100) {
    const period = 100000; // 100 ms
    const quota  = Math.round(period * cpuQuotaPct / 100);
    cgWrite(cgPath, 'cpu.max', `${quota} ${period}`);
  } else {
    cgWrite(cgPath, 'cpu.max', `max 100000`);
  }
}

/**
 * Add a PID to the site's cgroup.  Call immediately after spawn().
 * The tiny race window before this returns is covered by fuser -k fallback
 * in stopSite(), but in practice the process hasn't forked workers yet.
 */
function addToCgroup(siteName, pid) {
  if (!pid) return;
  const cgPath = cgroupPath(siteName);
  try { fs.writeFileSync(path.join(cgPath, 'cgroup.procs'), String(pid) + '\n'); } catch {}
}

/**
 * Kill every process in the cgroup atomically.
 * cgroup.kill sends SIGKILL to every task in the hierarchy simultaneously —
 * no process can fork a child and escape before the signal lands.
 * Falls back to SIGKILL-by-pid-list if the file doesn't exist (pre-5.14 kernel).
 */
function killCgroup(siteName) {
  const cgPath = cgroupPath(siteName);

  // Try the atomic kill first (Linux 5.14+, Ubuntu 22.04 HWE kernels)
  try {
    fs.writeFileSync(path.join(cgPath, 'cgroup.kill'), '1\n');
    return;
  } catch {}

  // Fallback: kill each PID listed in cgroup.procs
  try {
    const procs = fs.readFileSync(path.join(cgPath, 'cgroup.procs'), 'utf8');
    for (const pidStr of procs.trim().split('\n').filter(Boolean)) {
      try { process.kill(parseInt(pidStr), 'SIGKILL'); } catch {}
    }
  } catch {}
}

/**
 * Remove the cgroup directory after all processes have exited.
 * A non-empty cgroup cannot be rmdir'd — call killCgroup() first.
 */
function removeCgroup(siteName) {
  const cgPath = cgroupPath(siteName);
  // Give processes a moment to fully exit after the kill signal
  setTimeout(() => {
    try { fs.rmdirSync(cgPath); } catch {}
  }, 500);
}

/**
 * Update resource limits on a running cgroup.
 * The kernel applies the new values immediately — no restart needed.
 */
function updateLimits(siteName, memLimitMb, cpuQuotaPct) {
  createCgroup(siteName, memLimitMb, cpuQuotaPct);
}

/**
 * Read the exact total RSS of all processes in the cgroup.
 * Returns bytes, or 0 if the cgroup doesn't exist yet.
 */
function readCgroupMemory(siteName) {
  try {
    return parseInt(fs.readFileSync(path.join(cgroupPath(siteName), 'memory.current'), 'utf8')) || 0;
  } catch { return 0; }
}

/**
 * Read memory.events to detect OOM kills.
 * Returns an object like { oom: N, oom_kill: N, ... }
 */
function readCgroupEvents(siteName) {
  const result = { oom: 0, oom_kill: 0 };
  try {
    const raw = fs.readFileSync(path.join(cgroupPath(siteName), 'memory.events'), 'utf8');
    for (const line of raw.trim().split('\n')) {
      const [key, val] = line.split(' ');
      if (key in result) result[key] = parseInt(val) || 0;
    }
  } catch {}
  return result;
}

/** True if the site's cgroup directory exists. */
function cgroupExists(siteName) {
  return fs.existsSync(cgroupPath(siteName));
}

/** Expose the base path so server.js can log it on startup. */
function getCgroupBase() { return CGROUP_BASE; }

module.exports = {
  createCgroup,
  addToCgroup,
  killCgroup,
  removeCgroup,
  updateLimits,
  readCgroupMemory,
  readCgroupEvents,
  cgroupExists,
  getCgroupBase,
};
