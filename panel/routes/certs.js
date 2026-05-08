const express = require('express');
const db = require('../db/database');
const ssl = require('../services/ssl');
const nginx = require('../services/nginx');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();

// List all certificates with status and linked sites
router.get('/', requireAuth, requireOwner, (req, res) => {
  const certs = db.prepare('SELECT id, name, common_name, expires_at, created_at FROM certificates ORDER BY created_at DESC').all();
  const result = certs.map(c => {
    const status = ssl.getSSLStatus(c.id);
    const linkedSites = db.prepare('SELECT id, name, domain FROM sites WHERE cert_id = ?').all(c.id);
    return { ...c, ...status, linked_sites: linkedSites };
  });
  res.json(result);
});

// Get a single certificate (no PEM — metadata only)
router.get('/:id', requireAuth, requireOwner, (req, res) => {
  const cert = db.prepare('SELECT id, name, common_name, expires_at, created_at FROM certificates WHERE id = ?').get(req.params.id);
  if (!cert) return res.status(404).json({ error: 'Certificate not found' });
  const status = ssl.getSSLStatus(cert.id);
  const linkedSites = db.prepare('SELECT id, name, domain FROM sites WHERE cert_id = ?').all(cert.id);
  res.json({ ...cert, ...status, linked_sites: linkedSites });
});

// Create a new certificate (paste PEM)
router.post('/', requireAuth, requireOwner, (req, res) => {
  const { name, cert, key } = req.body;
  if (!name || !cert || !key) return res.status(400).json({ error: 'name, cert, and key are required' });

  try {
    const parsed = ssl.parseCert(cert);

    const result = db.prepare(
      'INSERT INTO certificates (name, cert_pem, key_pem, common_name, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(name.trim(), cert.trim(), key.trim(), parsed.commonName, parsed.expiresAt);

    const certId = result.lastInsertRowid;
    ssl.installCert(certId, cert, key);

    const created = db.prepare('SELECT id, name, common_name, expires_at, created_at FROM certificates WHERE id = ?').get(certId);
    res.status(201).json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a certificate — unlinks from sites, regenerates their nginx configs
router.delete('/:id', requireAuth, requireOwner, (req, res) => {
  const cert = db.prepare('SELECT id FROM certificates WHERE id = ?').get(req.params.id);
  if (!cert) return res.status(404).json({ error: 'Certificate not found' });

  // Collect linked sites before deleting (FK will null cert_id on DELETE)
  const linkedSites = db.prepare('SELECT * FROM sites WHERE cert_id = ?').all(cert.id);

  ssl.removeCert(cert.id);
  db.prepare('DELETE FROM certificates WHERE id = ?').run(cert.id);
  // FK ON DELETE SET NULL already cleared cert_id on linked sites

  // Regenerate nginx configs for previously linked sites (now without SSL)
  for (const site of linkedSites) {
    const fresh = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
    try { nginx.writeSiteConfig(fresh); } catch (e) { console.error(`nginx config error for ${site.name}:`, e.message); }
  }
  if (linkedSites.length) nginx.reloadNginx();

  res.json({ success: true });
});

module.exports = router;
