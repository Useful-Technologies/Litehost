'use strict';

/**
 * scheduler.js — per-site periodic restart timers
 *
 * Supports: '10min', '30min', '60min'
 * Only restarts sites whose status is 'running' — manual stops are respected.
 */

const db = require('../db/database');
const pm = require('./process-manager');

const SCHEDULES = {
  '10min': 10 * 60 * 1000,
  '30min': 30 * 60 * 1000,
  '60min': 60 * 60 * 1000,
};

// siteId → { handle, schedule }
const timers = new Map();

async function doRestart(siteId) {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) { clearSchedule(siteId); return; }

  // Only restart if the site is currently running — respect manual stops
  if (!pm.isRunning(siteId)) {
    console.log(`[scheduler] Skipping scheduled restart of "${site.name}" — not running`);
    return;
  }

  console.log(`[scheduler] Auto-restarting "${site.name}" (schedule: ${site.restart_schedule})`);

  pm.stopSite(siteId);
  await new Promise(r => setTimeout(r, 500));

  try {
    pm.startSite(site);
    console.log(`[scheduler] "${site.name}" restarted OK`);
  } catch (e) {
    console.error(`[scheduler] Failed to restart "${site.name}": ${e.message}`);
  }
}

function setSchedule(siteId, scheduleStr) {
  // Clear any existing timer first
  clearSchedule(siteId);

  const ms = SCHEDULES[scheduleStr];
  if (!ms) return; // null / '' / unknown → no timer

  const handle = setInterval(() => doRestart(siteId), ms);
  timers.set(siteId, { handle, schedule: scheduleStr });
  console.log(`[scheduler] Site ${siteId} → restart every ${scheduleStr}`);
}

function clearSchedule(siteId) {
  const entry = timers.get(siteId);
  if (!entry) return;
  clearInterval(entry.handle);
  timers.delete(siteId);
  console.log(`[scheduler] Cleared restart schedule for site ${siteId}`);
}

// Restore schedules from DB on boot
function initSchedules() {
  const sites = db.prepare(
    "SELECT id, name, restart_schedule FROM sites WHERE restart_schedule IS NOT NULL AND restart_schedule != ''"
  ).all();

  for (const site of sites) {
    setSchedule(site.id, site.restart_schedule);
  }

  if (sites.length) {
    console.log(`[scheduler] Restored ${sites.length} restart schedule(s)`);
  }
}

module.exports = { setSchedule, clearSchedule, initSchedules, SCHEDULES };
