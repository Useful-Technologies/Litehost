const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const SITES_DIR = '/opt/hosted-sites';
const LOG_DIR = '/var/log/hostctl';
const POLL_INTERVAL_MS = 60 * 1000; // check every 60 seconds

// Tracks sites currently being deployed — prevents concurrent auto-deploys
const deploying = new Set();

function logLine(siteName, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [auto-deploy] ${msg}\n`;
  try {
    fs.appendFileSync(`${LOG_DIR}/${siteName}.log`, line);
  } catch {}
  console.log(`[git-poller] ${siteName}: ${msg}`);
}

function getRemoteHead(siteDir, branch) {
  return execSync(`git -C ${siteDir} rev-parse origin/${branch}`, { stdio: 'pipe' })
    .toString().trim();
}

function getLocalHead(siteDir) {
  return execSync(`git -C ${siteDir} rev-parse HEAD`, { stdio: 'pipe' })
    .toString().trim();
}

function checkAndDeploy(site) {
  if (deploying.has(site.id)) return; // already deploying

  const siteDir = `${SITES_DIR}/${site.name}`;
  const branch = site.git_branch || 'main';
  const gitDir = path.join(siteDir, '.git');

  if (!fs.existsSync(gitDir)) {
    // Not initialized yet — skip silently (user needs to do first manual deploy)
    return;
  }

  try {
    // Fetch latest from remote (quiet)
    execSync(`git -C ${siteDir} fetch origin ${branch}`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    const local  = getLocalHead(siteDir);
    const remote = getRemoteHead(siteDir, branch);

    if (local === remote) return; // nothing new

    deploying.add(site.id);
    logLine(site.name, `New commit detected (${remote.slice(0, 7)}) — deploying…`);

    // Pull
    const out = execSync(
      `git -C ${siteDir} reset --hard origin/${branch}`,
      { stdio: 'pipe', timeout: 60000 }
    ).toString().trim();
    logLine(site.name, out);

    // Restart or reload
    const pm    = require('./process-manager');
    const nginx = require('./nginx');

    if (['node', 'custom'].includes(site.runtime)) {
      pm.stopSite(site.id);
      const pid = pm.startSite(site);
      logLine(site.name, `Process restarted (pid ${pid})`);
    } else {
      nginx.reloadNginx();
      logLine(site.name, 'Nginx reloaded');
    }

    db.prepare(
      "INSERT INTO activity_log (site_id, action, detail) VALUES (?, 'auto_deploy', ?)"
    ).run(site.id, `Auto-deployed commit ${remote.slice(0, 7)}`);

  } catch (e) {
    logLine(site.name, `Error: ${e.stderr ? e.stderr.toString().trim() : e.message}`);
  } finally {
    deploying.delete(site.id);
  }
}

function poll() {
  const sites = db.prepare(
    "SELECT * FROM sites WHERE git_auto_deploy = 1 AND git_repo IS NOT NULL"
  ).all();

  for (const site of sites) {
    // Run each check in a try/catch so one failure doesn't stop the others
    try { checkAndDeploy(site); } catch (e) {
      console.error(`[git-poller] Unexpected error for ${site.name}:`, e.message);
    }
  }
}

function start() {
  console.log(`[git-poller] Started — polling every ${POLL_INTERVAL_MS / 1000}s`);
  setInterval(poll, POLL_INTERVAL_MS);
}

module.exports = { start };
