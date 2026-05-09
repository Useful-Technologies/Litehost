const express = require('express');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ─── Shared state ─────────────────────────────────────────────────────────────
// The background sampler writes here; the API endpoint just reads it.
// Initialised to null so the UI can show "—" until the first sample lands.
const stats = {
  cpu:    { percent: null },
  memory: { total: 0, used: 0, free: 0 },
  disk:   null,
  loadAvg: { '1m': 0, '5m': 0, '15m': 0 },
  uptime: 0,
};

// ─── CPU ──────────────────────────────────────────────────────────────────────
// Keep the previous /proc/stat snapshot so each tick calculates a true delta.
// A 5-second window is more accurate than the old 250 ms per-request sample.
let _prevStat = null;

function readProcStat() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const nums = line.trim().split(/\s+/).slice(1).map(Number);
    // idle = idle + iowait fields (indices 3, 4)
    return { idle: (nums[3] || 0) + (nums[4] || 0), total: nums.reduce((a, b) => a + b, 0) };
  } catch { return null; }
}

function sampleCpu() {
  const cur = readProcStat();
  if (cur && _prevStat) {
    const dt = cur.total - _prevStat.total;
    const di = cur.idle  - _prevStat.idle;
    stats.cpu.percent = dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : 0;
  }
  if (cur) _prevStat = cur;
}

// ─── Memory ───────────────────────────────────────────────────────────────────
function sampleMemory() {
  const total = os.totalmem();
  let free = os.freemem();
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (m) free = parseInt(m[1], 10) * 1024;
  } catch {}
  stats.memory = { total, used: total - free, free };
}

// ─── Disk ─────────────────────────────────────────────────────────────────────
// Prefer fs.statfsSync (Node 19+ — pure syscall, no subprocess).
// Fall back to execSync('df') on older Node; disk changes slowly so this
// only runs once every 6 ticks (every ~30 s at a 5-second interval).
function sampleDisk() {
  if (typeof fs.statfsSync === 'function') {
    try {
      const s = fs.statfsSync('/');
      stats.disk = {
        total: s.blocks * s.bsize,
        used:  (s.blocks - s.bfree) * s.bsize,
        free:  s.bavail * s.bsize,
      };
      return;
    } catch {}
  }
  try {
    const out = execSync('df -k --output=size,used,avail /', { stdio: 'pipe', timeout: 5000 })
      .toString().trim().split('\n');
    if (out[1]) {
      const [sz, used, avail] = out[1].trim().split(/\s+/).map(Number);
      stats.disk = { total: sz * 1024, used: used * 1024, free: avail * 1024 };
    }
  } catch {}
}

// ─── Background sampler ───────────────────────────────────────────────────────
let _diskTick = 0;

function startSampler(intervalMs = 5000) {
  // Seed the CPU baseline before the first tick so we have a delta immediately
  _prevStat = readProcStat();
  sampleMemory();
  sampleDisk();

  setInterval(() => {
    sampleCpu();
    sampleMemory();
    const [l1, l5, l15] = os.loadavg();
    stats.loadAvg = { '1m': +l1.toFixed(2), '5m': +l5.toFixed(2), '15m': +l15.toFixed(2) };
    stats.uptime  = Math.round(os.uptime());

    // Disk: every 6 ticks (~30 s). No need to check every 5 s.
    if (++_diskTick % 6 === 0) sampleDisk();
  }, intervalMs);
}

// Kick off as soon as the module is loaded — no change needed in server.js
startSampler();

// ─── Route ────────────────────────────────────────────────────────────────────
// Purely synchronous — just serialise the in-memory object.
router.get('/stats', requireAuth, (req, res) => res.json(stats));

module.exports = router;
