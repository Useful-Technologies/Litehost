// Centralized API client
const api = {
  async _request(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api' + path, opts);
    if (res.status === 401) { window.location.href = '/login'; return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  get: (path) => api._request('GET', path),
  post: (path, body) => api._request('POST', path, body),
  put: (path, body) => api._request('PUT', path, body),
  patch: (path, body) => api._request('PATCH', path, body),
  delete: (path, body) => api._request('DELETE', path, body),

  async upload(siteId, path, files) {
    const fd = new FormData();
    fd.append('path', path);
    for (const f of files) fd.append('files', f);
    const res = await fetch(`/api/sites/${siteId}/files/upload`, {
      method: 'POST', body: fd, credentials: 'same-origin'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  }
};

// Toast notifications
const toast = {
  container: null,
  init() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },
  show(msg, type = 'info', duration = 3500) {
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
    this.container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(100%)'; t.style.transition = '0.3s'; setTimeout(() => t.remove(), 300); }, duration);
  },
  success: (msg) => toast.show(msg, 'success'),
  error: (msg) => toast.show(msg, 'error'),
  info: (msg) => toast.show(msg, 'info'),
};

// Modal helper
function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
  if (e.target.classList.contains('modal-close')) e.target.closest('.modal-overlay')?.classList.remove('open');
});

// Format helpers
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}
function formatDate(d) { return d ? new Date(d).toLocaleString() : '—'; }
function formatDateShort(d) { return d ? new Date(d).toLocaleDateString() : '—'; }

function runtimeBadge(rt) {
  const map = { static: ['badge-blue', '🌐 Static'], php: ['badge-purple', '🐘 PHP'], node: ['badge-green', '⬡ Node.js'], custom: ['badge-yellow', '⚙ Custom'] };
  const [cls, label] = map[rt] || ['badge-muted', rt];
  return `<span class="badge ${cls}">${label}</span>`;
}
function statusBadge(s) {
  const map = { running: ['badge-green', '● Running'], stopped: ['badge-muted', '○ Stopped'], error: ['badge-red', '✕ Error'] };
  const [cls, label] = map[s] || ['badge-muted', s];
  return `<span class="badge ${cls}">${label}</span>`;
}
function dnsBadge(s) {
  const map = { connected: ['badge-green', '✓ Connected'], propagating: ['badge-yellow', '⏳ Propagating'], not_pointing: ['badge-red', '✕ Not Pointing'], none: ['badge-muted', '— No Domain'] };
  const [cls, label] = map[s] || ['badge-muted', s || 'Unknown'];
  return `<span class="badge ${cls}">${label}</span>`;
}
function sslBadge(s) {
  const map = { active: ['badge-green', '🔒 SSL Active'], expiring: ['badge-yellow', '⚠ Expiring'], expired: ['badge-red', '✕ Expired'], none: ['badge-muted', '🔓 No SSL'] };
  const [cls, label] = map[s] || ['badge-muted', s || 'None'];
  return `<span class="badge ${cls}">${label}</span>`;
}
