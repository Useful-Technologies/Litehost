require('dotenv').config({ path: '/etc/hostctl/litehost.env' });

const express = require('express');
const session = require('express-session');
const SqliteStore = require('connect-sqlite3')(session);
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const db = require('./db/database');
const pm        = require('./services/process-manager');
const nginx     = require('./services/nginx');
const cgroup    = require('./services/cgroup');
const scheduler = require('./services/scheduler');

const app = express();
const PORT = process.env.PANEL_PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-' + Math.random();

if (SESSION_SECRET.startsWith('change-me-')) {
  console.warn('[warn] SESSION_SECRET not set — using random value. Sessions will not survive restarts.');
}

// For the deploy webhook route, capture the raw body BEFORE express.json
// consumes the stream — the HMAC signature must be verified against the
// original bytes, not a re-serialised parse.  express.raw sets req._body=true
// so express.json skips the route cleanly afterwards.
app.use('/api/deploy', express.raw({ type: '*/*', limit: '10mb' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
  store: new SqliteStore({ db: 'sessions.db', dir: '/etc/hostctl' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
  name: 'litehost.sid',
}));

// Static assets — no auth required
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

// Preview — serve site files publicly, no auth
app.use('/preview/:siteName', (req, res, next) => {
  const { siteName } = req.params;
  if (!/^[a-z0-9-]+$/.test(siteName)) return res.status(400).send('Invalid site name');
  const siteDir = path.join('/opt/hosted-sites', siteName);
  if (!fs.existsSync(siteDir)) return res.status(404).send('Site not found');
  express.static(siteDir, { redirect: false })(req, res, () => {
    res.sendFile(path.join(siteDir, 'index.html'), err => {
      if (err) res.status(404).send('Not found');
    });
  });
});

// API routes
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/sites',  require('./routes/sites'));
app.use('/api/sites/:siteId/files', require('./routes/files'));
app.use('/api/users',  require('./routes/users'));
app.use('/api/certs',  require('./routes/certs'));
app.use('/api/deploy', require('./routes/deploy'));
app.use('/api/system',  require('./routes/system'));
app.use('/api/upgrade', require('./routes/upgrade'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Login page — redirect to dashboard if already authenticated
app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

// All other routes — enforce authentication, serve SPA
app.get('*', (req, res) => {
  if (!req.session?.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

async function ensureOwner() {
  const { count } = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (count > 0) return;

  const username = process.env.OWNER_USERNAME || 'admin';
  const password = process.env.OWNER_PASSWORD || generatePassword();
  const hash = await bcrypt.hash(password, 12);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'owner')")
    .run(username, hash);

  const credFile = '/etc/hostctl/owner-credentials.txt';
  fs.writeFileSync(credFile, `Litehost Owner Credentials\nUsername: ${username}\nPassword: ${password}\n`, { mode: 0o600 });
  console.log('\n=== OWNER ACCOUNT CREATED ===');
  console.log(`Username: ${username}`);
  console.log(`Password: ${password}`);
  console.log(`Credentials saved: ${credFile}`);
  console.log('==============================\n');
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── Automatic isolation migration ───────────────────────────────────────────
// Runs once on the first boot after the isolation update.  For each existing
// site that has no sys_user yet, create a dedicated Linux user, chown the
// site directory, and set up a cgroup.  Idempotent — safe to run on every
// boot (the WHERE clause filters out already-migrated sites instantly).
const { execSync: _execSync } = require('child_process');

async function migrateIsolation() {
  const sites = db.prepare('SELECT * FROM sites WHERE sys_user IS NULL').all();
  if (!sites.length) return;

  console.log(`[migrate] Upgrading ${sites.length} site(s) to per-user isolation…`);
  let phpReload = false;

  for (const site of sites) {
    const sysUser = `lh-${site.name}`.slice(0, 31);
    const siteDir = `/opt/hosted-sites/${site.name}`;

    try {
      _execSync(
        `sudo useradd -r -M -s /usr/sbin/nologin -d ${siteDir} ${sysUser}`,
        { stdio: 'pipe' }
      );
    } catch (e) {
      if (!e.stderr?.toString().includes('already exists')) {
        console.warn(`[migrate] useradd ${sysUser}: ${e.message}`);
      }
    }

    try {
      _execSync(`sudo chown -R ${sysUser}:${sysUser} ${siteDir}`, { stdio: 'pipe' });
    } catch (e) {
      console.warn(`[migrate] chown ${siteDir}: ${e.message}`);
    }

    db.prepare('UPDATE sites SET sys_user = ? WHERE id = ?').run(sysUser, site.id);
    cgroup.createCgroup(site.name, site.mem_limit_mb || null, null);

    if (site.runtime === 'php') {
      const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
      try { nginx.writePHPPool(updated); phpReload = true; } catch (e) {
        console.warn(`[migrate] writePHPPool ${site.name}: ${e.message}`);
      }
    }

    console.log(`[migrate] ✓ ${site.name} → ${sysUser}`);
  }

  if (phpReload) {
    try { _execSync('sudo systemctl reload php8.1-fpm', { stdio: 'pipe' }); } catch {}
  }

  console.log('[migrate] Isolation migration complete.');
}

async function boot() {
  await ensureOwner();
  console.log(`[cgroup] Delegated subtree: ${cgroup.getCgroupBase()}`);
  await migrateIsolation();
  try {
    nginx.writeDefaultConfig();
    nginx.reloadNginx();
  } catch (e) {
    console.warn('[nginx] Could not write default config:', e.message);
  }
  pm.recoverProcesses();
  scheduler.initSchedules();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Litehost panel running on http://0.0.0.0:${PORT}`);
  });
}

boot().catch(err => { console.error('Boot failed:', err); process.exit(1); });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
