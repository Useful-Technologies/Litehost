const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const db = require('../db/database');
const { requireAuth, requireOwner, requireSitePermission } = require('../middleware/auth');
const nginx = require('../services/nginx');
const ssl   = require('../services/ssl');
const dns   = require('../services/dns');
const pm        = require('../services/process-manager');
const cgroup    = require('../services/cgroup');
const scheduler = require('../services/scheduler');

const router = express.Router();

const SITES_DIR = '/opt/hosted-sites';
const CONF_DIR = '/etc/hostctl/sites';
const LOG_DIR = '/var/log/hostctl';

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ─── Per-site Linux user helpers ──────────────────────────────────────────────
// Linux usernames are capped at 32 chars.  "lh-" + up to 28 site-name chars.
function siteUser(name) {
  return `lh-${name}`.slice(0, 31);
}

function createSiteUser(name, siteDir) {
  const user = siteUser(name);
  try {
    execSync(
      `sudo useradd -r -M -s /usr/sbin/nologin -d ${siteDir} ${user}`,
      { stdio: 'pipe' }
    );
  } catch (e) {
    // Ignore "already exists" — can happen if site is being recreated
    if (!e.stderr?.toString().includes('already exists')) {
      console.warn(`[sites] useradd ${user}:`, e.message);
    }
  }
  try {
    execSync(`sudo chown -R ${user}:${user} ${siteDir}`, { stdio: 'pipe' });
  } catch (e) {
    console.warn(`[sites] chown ${siteDir}:`, e.message);
  }
  return user;
}

function removeSiteUser(name) {
  const user = siteUser(name);
  try {
    execSync(`sudo userdel -r ${user}`, { stdio: 'pipe' });
  } catch (e) {
    // Ignore "does not exist" — might have been cleaned up already
    if (!e.stderr?.toString().includes('does not exist')) {
      console.warn(`[sites] userdel ${user}:`, e.message);
    }
  }
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
  const { name, domain, runtime, start_command, php_version, mem_limit_mb, cpu_quota_pct } = req.body;
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

  const deploy_token = crypto.randomBytes(32).toString('hex');
  const memLimit  = mem_limit_mb  ? parseInt(mem_limit_mb)  : null;
  const cpuQuota  = cpu_quota_pct ? parseInt(cpu_quota_pct) : null;

  const result = db.prepare(`
    INSERT INTO sites (name, domain, runtime, port, start_command, php_version, deploy_token, mem_limit_mb, cpu_quota_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, domain || null, runtime || 'static', port, start_command || null, php_version || '8.1', deploy_token, memLimit, cpuQuota);

  // Create directories
  const siteDir = `${SITES_DIR}/${slug}`;
  fs.mkdirSync(siteDir, { recursive: true });
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Create per-site Linux user and chown the site directory
  const sys_user = createSiteUser(slug, siteDir);
  db.prepare('UPDATE sites SET sys_user = ? WHERE id = ?').run(sys_user, result.lastInsertRowid);

  // Create cgroup for resource isolation
  cgroup.createCgroup(slug, memLimit, cpuQuota);

  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(result.lastInsertRowid);

  // Write site config JSON
  fs.writeFileSync(`${CONF_DIR}/${slug}.json`, JSON.stringify(site, null, 2));

  // Write nginx config (+ PHP-FPM pool for php sites) and reload
  try {
    nginx.writeSiteConfig(site);
    if (site.runtime === 'php') nginx.writePHPPool(site);
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
  const sslStatus = ssl.getSSLStatus(site.cert_id);

  // Only expose deploy credentials to owners
  const payload = { ...site, dns: dnsStatus, ssl: sslStatus };
  if (req.user.role !== 'owner') {
    delete payload.deploy_token;
    delete payload.webhook_secret;
  }

  res.json(payload);
});

// Update site settings
router.patch('/:id', requireAuth, requireSitePermission('settings'), (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const { domain, start_command, php_version, env_vars, git_repo, git_branch, cert_id, git_auto_deploy, mem_limit_mb, cpu_quota_pct, restart_schedule } = req.body;

  if (start_command && !start_command.includes('{PORT}') &&
      (site.runtime === 'custom' || site.runtime === 'node')) {
    return res.status(400).json({ error: 'start_command must contain {PORT}' });
  }

  // Validate cert_id if provided
  if (cert_id !== undefined && cert_id !== null) {
    const certRow = require('../db/database').prepare('SELECT id FROM certificates WHERE id = ?').get(cert_id);
    if (!certRow) return res.status(400).json({ error: 'Certificate not found' });
  }

  const newMemLimit  = mem_limit_mb  !== undefined ? (mem_limit_mb  ? parseInt(mem_limit_mb)  : null) : undefined;
  const newCpuQuota  = cpu_quota_pct !== undefined ? (cpu_quota_pct ? parseInt(cpu_quota_pct) : null) : undefined;

  // Validate restart_schedule
  const validSchedules = Object.keys(scheduler.SCHEDULES);
  if (restart_schedule !== undefined && restart_schedule !== null && restart_schedule !== '' &&
      !validSchedules.includes(restart_schedule)) {
    return res.status(400).json({ error: `Invalid restart_schedule. Valid values: ${validSchedules.join(', ')}` });
  }
  const newSchedule = restart_schedule !== undefined ? (restart_schedule || null) : undefined;

  db.prepare(`
    UPDATE sites SET
      domain = COALESCE(?, domain),
      start_command = COALESCE(?, start_command),
      php_version = COALESCE(?, php_version),
      env_vars = COALESCE(?, env_vars),
      git_repo = ?,
      git_branch = COALESCE(?, git_branch),
      cert_id = ?,
      git_auto_deploy = COALESCE(?, git_auto_deploy),
      mem_limit_mb = CASE WHEN ? IS NOT NULL THEN ? ELSE mem_limit_mb END,
      cpu_quota_pct = CASE WHEN ? IS NOT NULL THEN ? ELSE cpu_quota_pct END,
      restart_schedule = CASE WHEN ? IS NOT NULL THEN ? ELSE restart_schedule END
    WHERE id = ?
  `).run(
    domain ?? null, start_command ?? null, php_version ?? null, env_vars ?? null,
    git_repo !== undefined ? (git_repo || null) : site.git_repo,
    git_branch || null,
    cert_id !== undefined ? (cert_id || null) : site.cert_id,
    git_auto_deploy !== undefined ? (git_auto_deploy ? 1 : 0) : null,
    newMemLimit  !== undefined ? 1 : null, newMemLimit  !== undefined ? newMemLimit  : null,
    newCpuQuota  !== undefined ? 1 : null, newCpuQuota  !== undefined ? newCpuQuota  : null,
    newSchedule  !== undefined ? 1 : null, newSchedule  !== undefined ? newSchedule  : null,
    site.id
  );

  const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
  fs.writeFileSync(`${CONF_DIR}/${site.name}.json`, JSON.stringify(updated, null, 2));

  // Apply new resource limits to the cgroup immediately (no restart needed)
  if (newMemLimit !== undefined || newCpuQuota !== undefined) {
    cgroup.updateLimits(
      site.name,
      updated.mem_limit_mb || null,
      updated.cpu_quota_pct || null
    );
  }

  // Apply new restart schedule immediately
  if (newSchedule !== undefined) {
    if (updated.restart_schedule) scheduler.setSchedule(site.id, updated.restart_schedule);
    else scheduler.clearSchedule(site.id);
  }

  try {
    nginx.writeSiteConfig(updated);
    if (updated.runtime === 'php') nginx.writePHPPool(updated);
    nginx.reloadNginx();
  } catch (e) { console.error('Nginx error:', e.message); }

  res.json(updated);
});

// Delete site (owner only)
router.delete('/:id', requireAuth, requireOwner, (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  // Cancel any restart schedule before stopping
  scheduler.clearSchedule(site.id);

  // Stop processes (uses cgroup.kill internally)
  pm.stopSite(site.id);

  // Belt-and-suspenders: nuke cgroup and remove it
  cgroup.killCgroup(site.name);
  cgroup.removeCgroup(site.name);

  // Remove PHP-FPM pool if applicable
  try { nginx.removePHPPool(site); } catch {}

  nginx.removeSiteConfig(site.name);
  nginx.reloadNginx();

  // Remove site files and config
  try { fs.rmSync(`${SITES_DIR}/${site.name}`, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(`${CONF_DIR}/${site.name}.json`); } catch {}

  // Delete the per-site Linux user
  removeSiteUser(site.name);

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
        try {
          const pid = pm.startSite(site);
          if (!res.writableEnded) res.json({ success: true, pid });
        } catch (e) {
          if (!res.writableEnded) res.status(500).json({ error: e.message });
        }
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

  const lines = parseInt(req.query.lines) || 100;

  // Collect all relevant log files for this site
  const logPaths = [
    `${LOG_DIR}/${site.name}.log`,         // node/custom process output
    `${LOG_DIR}/${site.name}-error.log`,   // nginx error log (static/php)
    `${LOG_DIR}/${site.name}-access.log`,  // nginx access log
  ];

  const allLines = [];
  for (const p of logPaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf8');
      allLines.push(...content.split('\n').filter(Boolean));
    } catch {}
  }

  if (!allLines.length) return res.json({ lines: [] });

  res.json({ lines: allLines.slice(-lines) });
});

// Rotate deploy token (generates a new one, invalidating the old)
router.post('/:id/rotate-deploy-token', requireAuth, requireOwner, (req, res) => {
  const site = db.prepare('SELECT id FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE sites SET deploy_token = ? WHERE id = ?').run(token, site.id);
  res.json({ deploy_token: token });
});

// Rotate webhook secret (generates a new one — must be re-entered in GitHub webhook settings)
router.post('/:id/rotate-webhook-secret', requireAuth, requireOwner, (req, res) => {
  const site = db.prepare('SELECT id FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE sites SET webhook_secret = ? WHERE id = ?').run(secret, site.id);
  res.json({ webhook_secret: secret });
});

// Git deploy
router.post('/:id/git/deploy', requireAuth, requireSitePermission('deploy'), async (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!site.git_repo) return res.status(400).json({ error: 'No git repository configured' });

  const siteDir = `${SITES_DIR}/${site.name}`;
  const branch = site.git_branch || 'main';
  const log = [];

  try {
    const gitDir = path.join(siteDir, '.git');
    fs.mkdirSync(siteDir, { recursive: true });

    if (fs.existsSync(gitDir)) {
      log.push(`$ git pull origin ${branch}`);
      const out = execSync(`git -C ${siteDir} pull origin ${branch} 2>&1`, { timeout: 60000 }).toString();
      log.push(out.trim());
    } else {
      // Directory already exists (Litehost creates it on site creation) — init in-place
      log.push(`$ git init && git fetch origin ${branch} && git reset --hard`);
      execSync(`git -C ${siteDir} init 2>&1`, { timeout: 10000 });
      execSync(`git -C ${siteDir} remote add origin ${site.git_repo} 2>&1`, { timeout: 10000 });
      const fetch = execSync(`git -C ${siteDir} fetch origin ${branch} 2>&1`, { timeout: 120000 }).toString();
      log.push(fetch.trim());
      const reset = execSync(`git -C ${siteDir} reset --hard origin/${branch} 2>&1`, { timeout: 30000 }).toString();
      log.push(reset.trim());
    }

    // Restart the process (node/custom) or reload nginx (static/php)
    if (['node', 'custom'].includes(site.runtime)) {
      pm.stopSite(site.id);
      // Brief pause to let the kernel release the port after SIGKILL
      await new Promise(r => setTimeout(r, 500));
      const pid = pm.startSite(site);
      log.push(`Restarted process (pid ${pid})`);
    } else {
      nginx.reloadNginx();
      log.push('Nginx reloaded');
    }

    db.prepare("INSERT INTO activity_log (user_id, site_id, action, detail) VALUES (?, ?, 'git_deploy', ?)").run(req.user.id, site.id, log.join('\n'));
    res.json({ success: true, log: log.join('\n') });
  } catch (e) {
    const errMsg = e.stdout ? e.stdout.toString() : e.message;
    log.push(`Error: ${errMsg}`);
    res.status(500).json({ error: errMsg, log: log.join('\n') });
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
