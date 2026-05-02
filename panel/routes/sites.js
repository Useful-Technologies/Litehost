const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { requireAuth, requireOwner, requireSitePermission } = require('../middleware/auth');
const nginx = require('../services/nginx');
const ssl = require('../services/ssl');
const dns = require('../services/dns');
const pm = require('../services/process-manager');

const router = express.Router();

const SITES_DIR = '/opt/hosted-sites';
const CONF_DIR = '/etc/hostctl/sites';
const LOG_DIR = '/var/log/hostctl';

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function getSiteForUser(user, siteId) {
  if (user.role === 'owner') {
    return db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  }
  const perm = db.prepare(
    'SELECT s.*, sp.permissions FROM sites s JOIN site_permissions sp ON s.id = sp.site_id WHERE s.id = ? AND sp.user_id = ?'
  ).get(siteId, user.id);
  return perm || null;
}

// List all sites (owner sees all, subusers see permitted only)
router.get('/', requireAuth, (req, res) => {
  let sites;
  if (req.user.role === 'owner') {
    sites = db.prepare('SELECT * FROM sites ORDER BY created_at DESC').all();
  } else {
    sites = db.prepare(`
      SELECT s.*, sp.permissions FROM sites s
      JOIN site_permissions sp ON s.id = sp.site_id
      WHERE sp.user_id = ?
      ORDER BY s.created_at DESC
    `).all(req.user.id);
  }
  res.json(sites);
});

// Create site (owner only)
router.post('/', requireAuth, requireOwner, (req, res) => {
  const { name, domain, runtime, start_command, php_version } = req.body;
  if (!name) return res.status(400).json({ error: 'Site name required' });

  const slug = slugify(name);
  if (!slug) return res.status(400).json({ error: 'Invalid site name' });

  // Validate custom/node sites
  if ((runtime === 'custom' || runtime === 'node') && start_command) {
    if (!start_command.includes('{PORT}')) {
      return res.status(400).json({ error: 'start_command must contain {PORT} placeholder' });
    }
  }

  const existing = db.prepare('SELECT id FROM sites WHERE name = ?').get(slug);
  if (existing) return res.status(409).json({ error: 'Site name already exists' });

  if (domain) {
    const domainTaken = db.prepare('SELECT id FROM sites WHERE domain = ?').get(domain);
    if (domainTaken) return res.status(409).json({ error: 'Domain already in use' });
  }

  let port = null;
  if (runtime === 'node' || runtime === 'custom') {
    try { port = pm.findFreePort(); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const result = db.prepare(`
    INSERT INTO sites (name, domain, runtime, port, start_command, php_version)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(slug, domain || null, runtime || 'static', port, start_command || null, php_version || '8.1');

  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(result.lastInsertRowid);

  // Create directories
  fs.mkdirSync(`${SITES_DIR}/${slug}`, { recursive: true });
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Write site config JSON
  fs.writeFileSync(`${CONF_DIR}/${slug}.json`, JSON.stringify(site, null, 2));

  // Write nginx config and reload
  try {
    nginx.writeSiteConfig(site);
    nginx.reloadNginx();
  } catch (e) {
    console.error('Nginx config error:', e.message);
  }

  db.prepare("INSERT INTO activity_log (user_id, site_id, action) VALUES (?, ?, 'create_site')").run(req.user.id, site.id);

  res.status(201).json(site);
});

// Get single site
router.get('/:id', requireAuth, (req, res) => {
  const site = getSiteForUser(req.user, req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const dnsStatus = site.domain ? dns.checkDNS(site.domain) : null;
  const sslStatus = ssl.getSSLStatus(site.domain);

  res.json({ ...site, dns: dnsStatus, ssl: sslStatus });
});

// Update site settings
router.patch('/:id', requireAuth, requireSitePermission('settings'), (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const { domain, start_command, php_version, env_vars } = req.body;

  if (start_command && !start_command.includes('{PORT}') &&
      (site.runtime === 'custom' || site.runtime === 'node')) {
    return res.status(400).json({ error: 'start_command must contain {PORT}' });
  }

  db.prepare(`
    UPDATE sites SET
      domain = COALESCE(?, domain),
      start_command = COALESCE(?, start_command),
      php_version = COALESCE(?, php_version),
      env_vars = COALESCE(?, env_vars)
    WHERE id = ?
  `).run(domain ?? null, start_command ?? null, php_version ?? null, env_vars ?? null, site.id);

  const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
  fs.writeFileSync(`${CONF_DIR}/${site.name}.json`, JSON.stringify(updated, null, 2));

  try {
    nginx.writeSiteConfig(updated);
    nginx.reloadNginx();
  } catch (e) { console.error('Nginx error:', e.message); }

  res.json(updated);
});

// Delete site (owner only)
router.delete('/:id', requireAuth, requireOwner, (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  pm.stopSite(site.id);
  nginx.removeSiteConfig(site.name);
  nginx.reloadNginx();

  try { fs.rmSync(`${SITES_DIR}/${site.name}`, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(`${CONF_DIR}/${site.name}.json`); } catch {}

  db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);

  res.json({ success: true });
});

// Start/stop/restart process (node/custom only)
router.post('/:id/process/:action', requireAuth, requireSitePermission('deploy'), (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const { action } = req.params;

  if (!['node', 'custom'].includes(site.runtime)) {
    return res.status(400).json({ error: 'Process control only for node/custom sites' });
  }

  try {
    if (action === 'start') {
      if (pm.isRunning(site.id)) return res.status(409).json({ error: 'Already running' });
      const pid = pm.startSite(site);
      return res.json({ success: true, pid });
    }
    if (action === 'stop') {
      pm.stopSite(site.id);
      return res.json({ success: true });
    }
    if (action === 'restart') {
      pm.stopSite(site.id);
      setTimeout(() => {
        const pid = pm.startSite(site);
        res.json({ success: true, pid });
      }, 500);
      return;
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.status(400).json({ error: 'Invalid action' });
});

// Get site logs
router.get('/:id/logs', requireAuth, requireSitePermission('view'), (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const logPath = `${LOG_DIR}/${site.name}.log`;
  const lines = parseInt(req.query.lines) || 100;

  if (!fs.existsSync(logPath)) return res.json({ lines: [] });

  const content = fs.readFileSync(logPath, 'utf8');
  const allLines = content.split('\n').filter(Boolean);
  res.json({ lines: allLines.slice(-lines) });
});

// Install SSL certificate
router.post('/:id/ssl', requireAuth, requireSitePermission('settings'), (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!site.domain) return res.status(400).json({ error: 'No domain set' });

  const { cert, key } = req.body;
  if (!cert || !key) return res.status(400).json({ error: 'Certificate and private key are required' });

  try {
    ssl.installCert(site.domain, cert, key);
    nginx.writeSiteConfig(site, true);
    nginx.reloadNginx();
    res.json({ success: true, message: `SSL certificate installed for ${site.domain}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DNS check
router.get('/:id/dns', requireAuth, requireSitePermission('view'), (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!site.domain) return res.json({ status: 'none', message: 'No domain configured' });

  res.json(dns.checkDNS(site.domain));
});

module.exports = router;
