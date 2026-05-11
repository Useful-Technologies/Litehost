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
router.post('/run', requireAuth, requireOwner, async (req, res) => {
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

  // Resolve the release tarball URL before building the step list so we can
  // show the version and avoid a git dependency on the production server.
  let tarballUrl, tag;
  try {
    const release = await fetchLatestRelease();
    tarballUrl = release.tarball_url;
    tag = release.tag_name || 'latest';
    if (!tarballUrl) throw new Error('No tarball_url in GitHub release response');
    send(`Downloading release ${tag}…`);
  } catch (e) {
    done(false, `Could not fetch release info from GitHub: ${e.message}`);
    return;
  }

  const tmpDir = `/tmp/lh-upgrade-${Date.now()}`;

  const steps = [
    `mkdir -p ${tmpDir}`,
    `curl -fsSL "${tarballUrl}" | tar -xz -C ${tmpDir} --strip-components=1`,
    `cp -r ${tmpDir}/panel/. ${PANEL_DIR}/`,
    `rm -rf ${tmpDir}`,
    `npm install --prefix ${PANEL_DIR} --production --no-audit`,
  ];

  let stepIdx = 0;

  function runNext() {
    if (stepIdx >= steps.length) {
      // All file steps done — tell the client we're restarting, then exit.
      // systemd (Restart=always) brings the panel back up with the new code.
      send('Restarting panel service…');
      done(true, 'Upgrade complete — reloading…');
      setTimeout(() => process.exit(0), 500);
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
