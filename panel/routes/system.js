const express = require('express');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Read the first "cpu" line from /proc/stat and return {idle, total}.
// idle  = idle + iowait fields
// total = sum of all fields
function procStat() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const nums = line.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal ...
    const idle  = (nums[3] || 0) + (nums[4] || 0);   // idle + iowait
    const total = nums.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

// GET /api/system/stats
// Returns cpu, memory, disk, loadAvg, uptime.
// Requires authentication — no owner gate, subusers can see system health too.
router.get('/stats', requireAuth, async (req, res) => {
  // ── CPU ────────────────────────────────────────────────────────────────────
  // Sample /proc/stat twice, 250 ms apart, and compute delta-based usage.
  const s1 = procStat();
  await new Promise(r => setTimeout(r, 250));
  const s2 = procStat();

  let cpuPercent = null;
  if (s1 && s2) {
    const totalDelta = s2.total - s1.total;
    const idleDelta  = s2.idle  - s1.idle;
    cpuPercent = totalDelta > 0
      ? Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)))
      : 0;
  }

  // ── Memory ─────────────────────────────────────────────────────────────────
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();

  // ── Disk (root partition) ──────────────────────────────────────────────────
  let disk = null;
  try {
    // df -k prints 1 KiB blocks; --output gives exactly the columns we want
    const out = execSync('df -k --output=size,used,avail /', { stdio: 'pipe', timeout: 5000 })
      .toString().trim().split('\n');
    if (out[1]) {
      const [size, used, avail] = out[1].trim().split(/\s+/).map(Number);
      disk = { total: size * 1024, used: used * 1024, free: avail * 1024 };
    }
  } catch {}

  // ── Load average ───────────────────────────────────────────────────────────
  const [l1, l5, l15] = os.loadavg();

  res.json({
    cpu: { percent: cpuPercent },
    memory: { total: totalMem, used: totalMem - freeMem, free: freeMem },
    disk,
    loadAvg: {
      '1m':  Math.round(l1  * 100) / 100,
      '5m':  Math.round(l5  * 100) / 100,
      '15m': Math.round(l15 * 100) / 100,
    },
    uptime: Math.round(os.uptime()),
  });
});

module.exports = router;
