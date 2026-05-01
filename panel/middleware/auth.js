const db = require('../db/database');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.redirect('/login');
  }
  req.user = user;
  next();
}

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
}

function requireSitePermission(...perms) {
  return (req, res, next) => {
    if (req.user.role === 'owner') return next();

    const siteId = req.params.siteId || req.params.id;
    if (!siteId) return res.status(400).json({ error: 'No site specified' });

    const row = db.prepare(
      'SELECT permissions FROM site_permissions WHERE user_id = ? AND site_id = ?'
    ).get(req.user.id, siteId);

    if (!row) return res.status(403).json({ error: 'No access to this site' });

    const userPerms = JSON.parse(row.permissions);
    const hasAdmin = userPerms.includes('admin');
    const hasAll = perms.every(p => hasAdmin || userPerms.includes(p));

    if (!hasAll) return res.status(403).json({ error: 'Insufficient permissions' });

    next();
  };
}

module.exports = { requireAuth, requireOwner, requireSitePermission };
