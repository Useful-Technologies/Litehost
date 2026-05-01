const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db/database');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();

const VALID_PERMS = new Set(['view', 'files', 'deploy', 'settings', 'admin']);

function validatePerms(perms) {
  if (!Array.isArray(perms)) return false;
  return perms.every(p => VALID_PERMS.has(p));
}

// List all subusers (owner only)
router.get('/', requireAuth, requireOwner, (req, res) => {
  const users = db.prepare(
    "SELECT id, username, role, created_at FROM users WHERE role != 'owner' ORDER BY created_at DESC"
  ).all();
  res.json(users);
});

// Create subuser (owner only)
router.post('/', requireAuth, requireOwner, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'subuser')"
  ).run(username.trim(), hash);

  res.status(201).json({ id: result.lastInsertRowid, username: username.trim(), role: 'subuser' });
});

// Delete subuser (owner only)
router.delete('/:id', requireAuth, requireOwner, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'owner') return res.status(403).json({ error: 'Cannot delete owner' });

  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.json({ success: true });
});

// Change password for subuser (owner only)
router.patch('/:id/password', requireAuth, requireOwner, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'owner') return res.status(403).json({ error: 'Cannot change owner password here' });

  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ success: true });
});

// Get permissions for a user across all sites
router.get('/:id/permissions', requireAuth, requireOwner, (req, res) => {
  const perms = db.prepare(`
    SELECT sp.*, s.name as site_name, s.domain
    FROM site_permissions sp
    JOIN sites s ON s.id = sp.site_id
    WHERE sp.user_id = ?
  `).all(req.params.id);
  res.json(perms.map(p => ({ ...p, permissions: JSON.parse(p.permissions) })));
});

// Set site permissions for a user (owner only)
router.put('/:id/permissions/:siteId', requireAuth, requireOwner, (req, res) => {
  const { permissions } = req.body;
  if (!validatePerms(permissions)) {
    return res.status(400).json({ error: 'Invalid permissions. Valid: view, files, deploy, settings, admin' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user || user.role === 'owner') return res.status(404).json({ error: 'Subuser not found' });

  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  db.prepare(`
    INSERT INTO site_permissions (user_id, site_id, permissions)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, site_id) DO UPDATE SET permissions = excluded.permissions
  `).run(user.id, site.id, JSON.stringify(permissions));

  res.json({ success: true, permissions });
});

// Remove site permissions for a user (owner only)
router.delete('/:id/permissions/:siteId', requireAuth, requireOwner, (req, res) => {
  db.prepare('DELETE FROM site_permissions WHERE user_id = ? AND site_id = ?')
    .run(req.params.id, req.params.siteId);
  res.json({ success: true });
});

// Change own password (any authenticated user)
router.patch('/me/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Both current and new password required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

  const hash = await bcrypt.hash(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ success: true });
});

module.exports = router;
