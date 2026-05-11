const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || '/etc/hostctl/litehost.db';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cert_pem TEXT NOT NULL,
    key_pem TEXT NOT NULL,
    common_name TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'subuser',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    domain TEXT,
    runtime TEXT NOT NULL DEFAULT 'static',
    status TEXT DEFAULT 'stopped',
    port INTEGER,
    start_command TEXT,
    php_version TEXT DEFAULT '8.1',
    node_version TEXT DEFAULT '20',
    env_vars TEXT DEFAULT '{}',
    git_repo TEXT,
    git_branch TEXT DEFAULT 'main',
    deploy_command TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS site_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    permissions TEXT NOT NULL DEFAULT '["view"]',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
    UNIQUE(user_id, site_id)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    site_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Keep only the 1000 most recent log entries.  Without this the table grows
  -- forever — every git deploy and site creation appends a row indefinitely.
  CREATE TRIGGER IF NOT EXISTS trim_activity_log
  AFTER INSERT ON activity_log
  BEGIN
    DELETE FROM activity_log WHERE id NOT IN (
      SELECT id FROM activity_log ORDER BY id DESC LIMIT 1000
    );
  END;
`);

// Migrate existing databases — columns
for (const col of ['git_repo', 'git_branch', 'deploy_command']) {
  try { db.exec(`ALTER TABLE sites ADD COLUMN ${col} TEXT`); } catch {}
}
try { db.exec(`UPDATE sites SET git_branch = 'main' WHERE git_branch IS NULL`); } catch {}
try { db.exec(`ALTER TABLE sites ADD COLUMN cert_id INTEGER REFERENCES certificates(id) ON DELETE SET NULL`); } catch {}
try { db.exec(`ALTER TABLE sites ADD COLUMN git_auto_deploy INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE sites ADD COLUMN deploy_token TEXT`); } catch {}
try { db.exec(`ALTER TABLE sites ADD COLUMN webhook_secret TEXT`); } catch {}
// Isolation columns — added in the cgroups v2 + per-user isolation update
try { db.exec(`ALTER TABLE sites ADD COLUMN sys_user TEXT`); } catch {}
try { db.exec(`ALTER TABLE sites ADD COLUMN mem_limit_mb INTEGER`); } catch {}
try { db.exec(`ALTER TABLE sites ADD COLUMN cpu_quota_pct INTEGER`); } catch {}
// Scheduled restart column
try { db.exec(`ALTER TABLE sites ADD COLUMN restart_schedule TEXT`); } catch {}

// Generate deploy tokens and webhook secrets for any sites that don't have them
const crypto = require('crypto');
for (const s of db.prepare('SELECT id FROM sites WHERE deploy_token IS NULL').all()) {
  db.prepare('UPDATE sites SET deploy_token = ? WHERE id = ?')
    .run(crypto.randomBytes(32).toString('hex'), s.id);
}
for (const s of db.prepare('SELECT id FROM sites WHERE webhook_secret IS NULL').all()) {
  db.prepare('UPDATE sites SET webhook_secret = ? WHERE id = ?')
    .run(crypto.randomBytes(32).toString('hex'), s.id);
}

// Migrate old domain-keyed SSL certs → certificates table
const CERT_DIR = '/etc/hostctl/certs';
try {
  if (fs.existsSync(CERT_DIR)) {
    for (const entry of fs.readdirSync(CERT_DIR)) {
      if (!entry.includes('.')) continue; // skip numeric ID dirs (new style)
      const oldDir = `${CERT_DIR}/${entry}`;
      const certFile = `${oldDir}/cert.pem`;
      const keyFile  = `${oldDir}/key.pem`;
      if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) continue;
      let row = db.prepare('SELECT id FROM certificates WHERE name = ?').get(entry);
      if (!row) {
        const cert = fs.readFileSync(certFile, 'utf8');
        const key  = fs.readFileSync(keyFile,  'utf8');
        const ins  = db.prepare('INSERT INTO certificates (name, cert_pem, key_pem) VALUES (?, ?, ?)').run(entry, cert, key);
        row = { id: ins.lastInsertRowid };
        const newDir = `${CERT_DIR}/${row.id}`;
        fs.mkdirSync(newDir, { recursive: true });
        fs.copyFileSync(certFile, `${newDir}/cert.pem`);
        fs.copyFileSync(keyFile,  `${newDir}/key.pem`);
        console.log(`[migrate] Imported SSL cert for ${entry} as cert #${row.id}`);
      }
      // Link to any site with this domain that isn't already linked
      db.prepare('UPDATE sites SET cert_id = ? WHERE domain = ? AND (cert_id IS NULL OR cert_id = 0)').run(row.id, entry);
    }
  }
} catch (e) { console.error('[migrate] SSL cert migration error:', e.message); }

module.exports = db;
