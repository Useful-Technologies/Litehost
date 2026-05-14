const express = require('express');
const os = require('os');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const pm = require('../services/process-manager');
const cgroup = require('../services/cgroup');
const db = require('../db/database');

// All running process-based sites (node/custom/worker) — used by sampleProcs()
const stmtRunningSites = db.prepare(
  "SELECT id, name, mem_limit_mb FROM sites WHERE status = 'running' AND runtime IN ('node','custom','worker')"
);

const router = express.Router();

// ─── Shared state ─────────────────────────────────────────────────────────────
// Written by the background sampler, read by the route handler.
const stats = {
  cpu:     { percent: null },
  memory:  { total: 0, used: 0, free: 0 },
  disk:    null,
  loadAvg: { '1m': 0, '5m': 0, '15m': 0 },
  uptime:  0,
  // Per-process RSS so the UI can show what's actually consuming memory
  procs:   { panel: { rss: 0, heapUsed: 0, heapTotal: 0 }, sites: [] },
  // Top processes by RSS — updated every ~30 s alongside disk
  top: [],
};

// ─── Zero-allocation /proc readers ────────────────────────────────────────────
// Open /proc/stat and /proc/meminfo once.  Linux's pread() (readSync with an
// explicit position) re-generates data from the kernel on every call so the
// fd never goes stale.  A single Buffer is reused across every tick — the
// only per-tick allocations are three small numbers written back into stats.

const _buf   = Buffer.allocUnsafe(8192); // shared; never replaced
let _statFd  = -1;
let _memFd   = -1;

// CPU delta state — plain numbers on the module scope, no object churn
let _prevIdle  = 0;
let _prevTotal = 0;

function openFd(path) {
  try { return fs.openSync(path, 'r'); } catch { return -1; }
}

// Parse an unsigned decimal integer starting at buf[pos]; advance pos past digits.
// Returns [value, newPos].
function scanUint(buf, pos, end) {
  let v = 0;
  while (pos < end && buf[pos] >= 48 && buf[pos] <= 57) v = v * 10 + buf[pos++] - 48;
  return [v, pos];
}

// ── CPU ───────────────────────────────────────────────────────────────────────
function sampleCpu() {
  if (_statFd < 0) _statFd = openFd('/proc/stat');
  if (_statFd < 0) return;

  let n;
  try { n = fs.readSync(_statFd, _buf, 0, 4096, 0); }
  catch { try { fs.closeSync(_statFd); } catch {} _statFd = -1; return; }

  // First line: "cpu  <user> <nice> <system> <idle> <iowait> <irq> ..."
  // Skip "cpu" label + spaces to reach the first digit.
  let pos = 0;
  while (pos < n && (_buf[pos] < 48 || _buf[pos] > 57)) pos++;

  let idle = 0, total = 0, field = 0;
  while (pos < n && _buf[pos] !== 10 /* \n */) {
    while (pos < n && _buf[pos] === 32) pos++; // skip spaces
    if (pos >= n || _buf[pos] === 10) break;
    const [num, next] = scanUint(_buf, pos, n);
    pos = next;
    if (field === 3 || field === 4) idle += num; // idle + iowait
    total += num;
    field++;
  }

  if (_prevTotal > 0) {
    const dt = total - _prevTotal;
    const di = idle  - _prevIdle;
    if (dt > 0) stats.cpu.percent = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
  }
  _prevIdle  = idle;
  _prevTotal = total;
}

// ── Memory ────────────────────────────────────────────────────────────────────
// ASCII codes for the two keys we care about — compared byte-by-byte, no String.
// "MemTotal:"     77 101 109 84 111 116 97 108 58  (9 bytes)
// "MemAvailable:" 77 101 109 65 118 97 105 108 97 98 108 101 58  (13 bytes)

function sampleMemory() {
  if (_memFd < 0) _memFd = openFd('/proc/meminfo');
  if (_memFd < 0) {
    // Fallback: os module (less accurate, but no crash)
    const t = os.totalmem(), f = os.freemem();
    stats.memory.total = t; stats.memory.used = t - f; stats.memory.free = f;
    return;
  }

  let n;
  try { n = fs.readSync(_memFd, _buf, 0, 8192, 0); }
  catch { try { fs.closeSync(_memFd); } catch {} _memFd = -1; return; }

  let memTotal = 0, memAvail = 0, pos = 0;

  while (pos < n && !(memTotal && memAvail)) {
    // Fast-path: both lines start with "Mem" (77,101,109)
    if (_buf[pos] === 77 && _buf[pos + 1] === 101 && _buf[pos + 2] === 109) {
      if (_buf[pos + 3] === 84) {
        // "MemTotal:" — skip 9 bytes to the value
        pos += 9;
        while (pos < n && _buf[pos] === 32) pos++;
        let [v, p] = scanUint(_buf, pos, n);
        memTotal = v * 1024; pos = p;
      } else if (_buf[pos + 3] === 65) {
        // "MemAvailable:" — skip 13 bytes to the value
        pos += 13;
        while (pos < n && _buf[pos] === 32) pos++;
        let [v, p] = scanUint(_buf, pos, n);
        memAvail = v * 1024; pos = p;
      }
    }
    // Advance to the next line
    while (pos < n && _buf[pos] !== 10) pos++;
    pos++;
  }

  if (memTotal > 0) {
    stats.memory.total = memTotal;
    stats.memory.used  = memTotal - memAvail;
    stats.memory.free  = memAvail;
  }
}

// ── Disk ──────────────────────────────────────────────────────────────────────
// Node 19+: fs.statfsSync() is a direct syscall — no subprocess, no allocation.
// Older Node: fall back to execSync('df'), run infrequently from the background loop.
const { execSync } = require('child_process');

function sampleDisk() {
  if (typeof fs.statfsSync === 'function') {
    try {
      const s = fs.statfsSync('/');
      // Mutate in place — no object created after the first sample
      if (!stats.disk) stats.disk = { total: 0, used: 0, free: 0 };
      stats.disk.total = s.blocks * s.bsize;
      stats.disk.used  = (s.blocks - s.bfree) * s.bsize;
      stats.disk.free  = s.bavail * s.bsize;
      return;
    } catch {}
  }
  try {
    const out = execSync('df -k --output=size,used,avail /', { stdio: 'pipe', timeout: 5000 })
      .toString().trim().split('\n');
    if (out[1]) {
      const [sz, used, avail] = out[1].trim().split(/\s+/).map(Number);
      if (!stats.disk) stats.disk = { total: 0, used: 0, free: 0 };
      stats.disk.total = sz * 1024;
      stats.disk.used  = used  * 1024;
      stats.disk.free  = avail * 1024;
    }
  } catch {}
}

// ─── Per-process memory ───────────────────────────────────────────────────────
// Read a single PID's RSS from /proc/<pid>/status.
function pidRss(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? parseInt(m[1], 10) * 1024 : 0;
  } catch { return 0; }
}

// Scan every entry in /proc, read Name + VmRSS.
// Returns { top: top-N individual processes, grouped: aggregated by name }.
// No subprocess — pure /proc reads.  Runs every ~30 s (same cadence as disk).
function topProcs(n = 15) {
  const list = [];
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return { top: [], grouped: [] }; }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
      const nameMatch = status.match(/^Name:\s+(.+)/m);
      const rssMatch  = status.match(/^VmRSS:\s+(\d+)/m);
      if (nameMatch && rssMatch) {
        list.push({ pid: parseInt(entry), name: nameMatch[1].trim(), rss: parseInt(rssMatch[1]) * 1024 });
      }
    } catch {}
  }

  // Top N individual processes
  list.sort((a, b) => b.rss - a.rss);
  const top = list.slice(0, n);

  // Grouped by process name — reveals multi-worker services (php-fpm, nginx, node)
  const byName = new Map();
  for (const p of list) {
    if (!p.rss) continue;
    const g = byName.get(p.name) || { name: p.name, count: 0, totalRss: 0 };
    g.count++;
    g.totalRss += p.rss;
    byName.set(p.name, g);
  }
  const grouped = [...byName.values()].sort((a, b) => b.totalRss - a.totalRss).slice(0, n);

  return { top, grouped };
}

function sampleProcs() {
  // Panel process (this Node.js process)
  const mu = process.memoryUsage();
  stats.procs.panel.rss       = mu.rss;
  stats.procs.panel.heapUsed  = mu.heapUsed;
  stats.procs.panel.heapTotal = mu.heapTotal;

  // All running process sites from DB — covers both Map-tracked and recovered processes.
  // cgroup memory.current is the authoritative source: it includes every forked worker
  // in the cgroup, regardless of whether we hold a reference to the PID.
  const sites = stmtRunningSites.all();
  stats.procs.sites.length = 0;
  for (const row of sites) {
    const rss = cgroup.readCgroupMemory(row.name);
    if (rss === 0 && !pm.isRunning(row.id)) continue; // skip if cgroup gone and not tracked
    stats.procs.sites.push({
      siteId:   row.id,
      rss,
      memLimit: row.mem_limit_mb ? row.mem_limit_mb * 1024 * 1024 : null,
    });
  }
}

// ─── Background sampler ───────────────────────────────────────────────────────
let _diskTick = 0;

function startSampler(intervalMs = 5000) {
  // Seed CPU baseline and get first disk reading before the interval fires
  _statFd = openFd('/proc/stat');
  _memFd  = openFd('/proc/meminfo');
  sampleCpu();    // seeds _prevIdle / _prevTotal
  sampleMemory();
  sampleDisk();
  sampleProcs();
  stats.top = topProcs();

  setInterval(() => {
    sampleCpu();
    sampleMemory();
    sampleProcs();
    const [l1, l5, l15] = os.loadavg(); // three numbers from libuv, no allocation
    stats.loadAvg['1m']  = Math.round(l1  * 100) / 100;
    stats.loadAvg['5m']  = Math.round(l5  * 100) / 100;
    stats.loadAvg['15m'] = Math.round(l15 * 100) / 100;
    stats.uptime         = Math.round(os.uptime());
    if (++_diskTick % 6 === 0) {
      sampleDisk();
      stats.top = topProcs(); // refresh top processes every ~30 s
    }
  }, intervalMs);
}

startSampler();

// ─── Route ────────────────────────────────────────────────────────────────────
router.get('/stats', requireAuth, (req, res) => res.json(stats));

module.exports = router;
