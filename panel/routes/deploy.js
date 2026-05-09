const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const db = require('../db/database');
const pm = require('../services/process-manager');
const nginx = require('../services/nginx');

const router = express.Router();
const SITES_DIR = '/opt/hosted-sites';

// Public endpoint — authenticated only by the deploy token in the URL.
// Triggered by GitHub Actions (curl -X POST URL) or a GitHub webhook.
router.post('/:token', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE deploy_token = ?').get(req.params.token);
  if (!site) return res.status(404).json({ error: 'Invalid deploy token' });
  if (!site.git_repo) return res.status(400).json({ error: 'No git repository configured for this site' });

  const siteDir = `${SITES_DIR}/${site.name}`;
  const branch  = site.git_branch || 'main';
  const log     = [];

  try {
    const gitDir = path.join(siteDir, '.git');
    fs.mkdirSync(siteDir, { recursive: true });

    if (fs.existsSync(gitDir)) {
      log.push(`$ git pull origin ${branch}`);
      const out = execSync(`git -C ${siteDir} pull origin ${branch} 2>&1`, { timeout: 60000 }).toString();
      log.push(out.trim());
    } else {
      // First deploy — initialise in-place (directory already exists from site creation)
      log.push(`$ git init && fetch origin ${branch} && reset --hard`);
      execSync(`git -C ${siteDir} init 2>&1`, { timeout: 10000 });
      execSync(`git -C ${siteDir} remote add origin ${site.git_repo} 2>&1`, { timeout: 10000 });
      log.push(execSync(`git -C ${siteDir} fetch origin ${branch} 2>&1`, { timeout: 120000 }).toString().trim());
      log.push(execSync(`git -C ${siteDir} reset --hard origin/${branch} 2>&1`, { timeout: 30000 }).toString().trim());
    }

    if (['node', 'custom'].includes(site.runtime)) {
      pm.stopSite(site.id);
      const pid = pm.startSite(site);
      log.push(`Process restarted (pid ${pid})`);
    } else {
      nginx.reloadNginx();
      log.push('Nginx reloaded');
    }

    db.prepare(
      "INSERT INTO activity_log (site_id, action, detail) VALUES (?, 'webhook_deploy', ?)"
    ).run(site.id, log.join('\n'));

    res.json({ success: true, site: site.name, log: log.join('\n') });
  } catch (e) {
    const errMsg = e.stdout ? e.stdout.toString() : e.message;
    log.push(`Error: ${errMsg}`);
    res.status(500).json({ error: errMsg, log: log.join('\n') });
  }
});

module.exports = router;
