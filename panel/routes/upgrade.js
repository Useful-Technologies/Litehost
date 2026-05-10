'use strict';

/**
 * upgrade.js — Litehost self-upgrade route
 *
 * GET  /api/upgrade/check   → { current, latest, updateAvailable }
 * POST /api/upgrade/run     → streams upgrade log via SSE, then restarts
 *
 * The version check result is cached for 1 hour so we don't hammer
 * the GitHub API on every dashboard load.
 */

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const { execSync, spawn } = require('child_process');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();

const GITHUB_REPO  = 'Useful-Technologies/Litehost';
const PANEL_DIR    = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(PANEL_DIR, 'VERSION');
const LITEHOST_DIR = path.resolve(PANEL_DIR, '..');

// ─── Current version ─────────────────────────────────────────────────────────
function getCurrentVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); }
  catch { return 'unknown'; }
}

// ─── GitHub latest release check (cached 1 hour) ─────────────────────────────
let _cachedCheck = null;
let _checkFetchedAt = 0;
const CHECK_TTL_MS = 60 * 60 * 1000; // 1 hour

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      headers: { 'User-Agent': 'Litehost-Panel/1.0' },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from GitHub')); }
      });
    }).on('error', reject);
  });
}

function semverGt(a, b) {
  // Returns true if semver string a > b.  Handles "v1.2.3" prefix.
  const parse = s => s.replace(/^v/, '').split('.').map(Number);
  const [aMaj, aMin, aPat = 0] = parse(a);
  const [bMaj, bMin, bPat = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get('/check', requireAuth, async (req, res) => {
  const current = getCurrentVersion();

  // Serve from cache if fresh (skip cache when ?bust is present)
  const now = Date.now();
  const bust = 'bust' in req.query;
  if (!bust && _cachedCheck && now - _checkFetchedAt < CHECK_TTL_MS) {
    return res.json({ ...(_cachedCheck), current });
  }

  try {
    const release = await fetchLatestRelease();
    const latest  = release.tag_name || 'unknown';
    const updateAvailable = current !== 'unknown' && semverGt(latest, current);
    _cachedCheck = { latest, updateAvailable, releaseUrl: release.html_url || null };
    _checkFetchedAt = now;
    res.json({ current, latest, updateAvailable, releaseUrl: release.html_url || null });
  } catch (e) {
    res.json({ current, latest: 'unknown', updateAvailable: false, error: e.message });
  }
});

// POST /api/upgrade/run — streams upgrade log via Server-Sent Events
router.post('/run', requireAuth, requireOwner, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(msg) {
    res.write(`data: ${JSON.stringify({ msg })}\n\n`);
  }
  function done(success, msg) {
    res.write(`data: ${JSON.stringify({ done: true, success, msg })}\n\n`);
    res.end();
  }

  send('Starting Litehost upgrade…');

  // Run upgrade steps in a child process so we don't block the event loop
  const steps = [
    `git -C ${LITEHOST_DIR} fetch origin`,
    `git -C ${LITEHOST_DIR} reset --hard origin/main`,
    `npm install --prefix ${PANEL_DIR} --production --no-audit`,
    `sudo systemctl restart litehost`,
  ];

  let stepIdx = 0;

  function runNext() {
    if (stepIdx >= steps.length) {
      done(true, 'Upgrade complete — reloading…');
      return;
    }
    const cmd = steps[stepIdx++];
    send(`$ ${cmd}`);
    try {
      const out = execSync(cmd, { stdio: 'pipe', timeout: 120000 }).toString().trim();
      if (out) send(out);
      runNext();
    } catch (e) {
      const errMsg = e.stderr?.toString().trim() || e.message;
      done(false, `Error: ${errMsg}`);
    }
  }

  runNext();
});

module.exports = router;
