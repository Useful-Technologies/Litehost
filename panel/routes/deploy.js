const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const db = require('../db/database');
const pm = require('../services/process-manager');
const nginx = require('../services/nginx');

const router = express.Router();
const SITES_DIR = '/opt/hosted-sites';

// Verify GitHub's X-Hub-Signature-256 header using timing-safe comparison.
// Returns true if valid, false if signature is wrong or missing.
function verifySignature(secret, rawBody, signature) {
  if (!signature || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    // Buffers were different lengths — definitely wrong
    return false;
  }
}

// Public endpoint — authenticated by deploy token in URL.
// If the request carries X-Hub-Signature-256 (GitHub webhook), the HMAC
// is verified against the site's webhook_secret before deploying.
router.post('/:token', async (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE deploy_token = ?').get(req.params.token);
  if (!site) return res.status(404).json({ error: 'Invalid deploy token' });
  if (!site.git_repo) return res.status(400).json({ error: 'No git repository configured' });

  // Signature verification — enforced when both sides have a secret configured
  const signature = req.headers['x-hub-signature-256'];
  if (site.webhook_secret) {
    if (!signature) {
      return res.status(401).json({ error: 'Missing X-Hub-Signature-256 — set the webhook secret in GitHub' });
    }
    // req.body is a Buffer (set by express.raw registered in server.js before express.json)
    const rawBody = req.body instanceof Buffer ? req.body : undefined;
    if (!verifySignature(site.webhook_secret, rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature — webhook secret mismatch' });
    }
  }

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
      // First deploy — init in-place (Litehost creates the dir on site creation)
      log.push(`$ git init && fetch origin ${branch} && reset --hard`);
      execSync(`git -C ${siteDir} init 2>&1`, { timeout: 10000 });
      execSync(`git -C ${siteDir} remote add origin ${site.git_repo} 2>&1`, { timeout: 10000 });
      log.push(execSync(`git -C ${siteDir} fetch origin ${branch} 2>&1`, { timeout: 120000 }).toString().trim());
      log.push(execSync(`git -C ${siteDir} reset --hard origin/${branch} 2>&1`, { timeout: 30000 }).toString().trim());
    }

    if (['node', 'custom'].includes(site.runtime)) {
      pm.stopSite(site.id);
      // Brief pause to let the kernel release the port after SIGKILL
      await new Promise(r => setTimeout(r, 500));
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
