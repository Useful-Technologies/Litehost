const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { requireAuth, requireSitePermission } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const SITES_DIR = '/opt/hosted-sites';

function getSiteDir(name) {
  return path.join(SITES_DIR, name);
}

function safePath(siteDir, relPath) {
  const resolved = path.resolve(siteDir, relPath || '');
  if (!resolved.startsWith(siteDir)) throw new Error('Path traversal blocked');
  return resolved;
}

function getSite(id) {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
}

// Multer setup — store to disk in temp, then move
const upload = multer({
  storage: multer.diskStorage({
    destination: '/tmp/litehost-uploads',
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

fs.mkdirSync('/tmp/litehost-uploads', { recursive: true });

// List directory
router.get('/', requireAuth, requireSitePermission('files'), (req, res) => {
  const site = getSite(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const siteDir = getSiteDir(site.name);
  let targetPath;
  try {
    targetPath = safePath(siteDir, req.query.path || '');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Path not found' });

  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

  const entries = fs.readdirSync(targetPath).map(name => {
    const fullPath = path.join(targetPath, name);
    const s = fs.statSync(fullPath);
    return {
      name,
      type: s.isDirectory() ? 'directory' : 'file',
      size: s.size,
      modified: s.mtime,
      path: path.relative(siteDir, fullPath),
    };
  });

  res.json({ path: req.query.path || '', entries });
});

// Read file
router.get('/read', requireAuth, requireSitePermission('files'), (req, res) => {
  const site = getSite(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const siteDir = getSiteDir(site.name);
  let filePath;
  try {
    filePath = safePath(siteDir, req.query.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
  if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File too large to edit (max 2MB)' });

  const content = fs.readFileSync(filePath, 'utf8');
  res.json({ path: req.query.path, content });
});

// Write/save file
router.put('/write', requireAuth, requireSitePermission('files'), (req, res) => {
  const site = getSite(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const siteDir = getSiteDir(site.name);
  const { path: relPath, content } = req.body;
  if (!relPath) return res.status(400).json({ error: 'Path required' });

  let filePath;
  try {
    filePath = safePath(siteDir, relPath);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content || '', 'utf8');
  res.json({ success: true });
});

// Upload file(s)
router.post('/upload', requireAuth, requireSitePermission('files'), upload.array('files', 20), (req, res) => {
  const site = getSite(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const siteDir = getSiteDir(site.name);
  let destDir;
  try {
    destDir = safePath(siteDir, req.body.path || '');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  fs.mkdirSync(destDir, { recursive: true });

  const uploaded = [];
  for (const file of req.files || []) {
    const dest = path.join(destDir, file.originalname);
    fs.renameSync(file.path, dest);
    uploaded.push(file.originalname);
  }

  res.json({ success: true, uploaded });
});

// Delete file or directory
router.delete('/', requireAuth, requireSitePermission('files'), (req, res) => {
  const site = getSite(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const siteDir = getSiteDir(site.name);
  let targetPath;
  try {
    targetPath = safePath(siteDir, req.body.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Path not found' });
  if (targetPath === siteDir) return res.status(400).json({ error: 'Cannot delete site root' });

  fs.rmSync(targetPath, { recursive: true, force: true });
  res.json({ success: true });
});

// Create directory
router.post('/mkdir', requireAuth, requireSitePermission('files'), (req, res) => {
  const site = getSite(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const siteDir = getSiteDir(site.name);
  let dirPath;
  try {
    dirPath = safePath(siteDir, req.body.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  fs.mkdirSync(dirPath, { recursive: true });
  res.json({ success: true });
});

module.exports = router;
