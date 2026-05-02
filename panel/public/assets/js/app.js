// ─── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let currentView = 'dashboard';
let currentSite = null;
let currentSiteTab = 'overview';
let editorState = { siteId: null, path: null };
let sslTargetSiteId = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  toast.init();
  try {
    currentUser = await api.get('/auth/me');
  } catch {
    window.location.href = '/login';
    return;
  }
  applyUserContext();
  setupNav();
  navigate('dashboard');
});

function applyUserContext() {
  document.getElementById('sidebarUsername').textContent = currentUser.username;
  const roleBadge = document.getElementById('sidebarRole');
  roleBadge.textContent = currentUser.role === 'owner' ? 'Owner' : 'Subuser';
  roleBadge.className = `role-badge ${currentUser.role}`;
  document.querySelectorAll('.owner-only').forEach(el => {
    el.style.display = currentUser.role === 'owner' ? '' : 'none';
  });
}

function setupNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });
}

function navigate(view, siteId) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const navTarget = view === 'site' ? 'sites' : view;
  document.querySelector(`.nav-item[data-view="${navTarget}"]`)?.classList.add('active');

  switch (view) {
    case 'dashboard': renderDashboard(); break;
    case 'sites':     renderSitesList(); break;
    case 'site':      renderSite(siteId); break;
    case 'users':     renderUsers(); break;
  }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function renderDashboard() {
  setPage('Dashboard', currentUser.role === 'owner'
    ? `<button class="btn btn-primary" onclick="openModal('createSiteModal')">+ New Site</button>` : '');

  const sites = await api.get('/sites').catch(() => []);
  const running = sites.filter(s => s.status === 'running').length;

  setContent(`
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Sites</div>
        <div class="stat-value">${sites.length}</div>
        <div class="stat-sub">across all runtimes</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Running Processes</div>
        <div class="stat-value">${running}</div>
        <div class="stat-sub">node/custom sites</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Static Sites</div>
        <div class="stat-value">${sites.filter(s => s.runtime === 'static').length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">PHP Sites</div>
        <div class="stat-value">${sites.filter(s => s.runtime === 'php').length}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">All Sites</span>
      </div>
      ${sitesTable(sites)}
    </div>
  `);
}

// ─── Sites List ───────────────────────────────────────────────────────────────
async function renderSitesList() {
  setPage('Sites', currentUser.role === 'owner'
    ? `<button class="btn btn-primary" onclick="openModal('createSiteModal')">+ New Site</button>` : '');

  const sites = await api.get('/sites').catch(() => []);
  setContent(`<div class="card">${sitesTable(sites)}</div>`);
}

function sitesTable(sites) {
  if (!sites.length) return `<p style="color:var(--muted);padding:20px;text-align:center">No sites yet${currentUser.role === 'owner' ? ' — create one to get started.' : '.'}</p>`;
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Name</th><th>Domain</th><th>Runtime</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${sites.map(s => `
            <tr>
              <td><strong>${s.name}</strong></td>
              <td>${s.domain ? `<a href="http://${s.domain}" target="_blank">${s.domain}</a>` : '<span style="color:var(--muted)">—</span>'}</td>
              <td>${runtimeBadge(s.runtime)}</td>
              <td>${statusBadge(s.status)}</td>
              <td>
                <button class="btn btn-sm btn-secondary" onclick="navigate('site', ${s.id})">Manage</button>
                ${currentUser.role === 'owner' ? `<button class="btn btn-sm btn-danger" onclick="deleteSite(${s.id}, '${s.name}')">Delete</button>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Site Detail ──────────────────────────────────────────────────────────────
async function renderSite(siteId) {
  setPage('Loading…', '');
  try {
    const site = await api.get(`/sites/${siteId}`);
    currentSite = site;
    setPage(
      `<span style="cursor:pointer;color:var(--muted)" onclick="navigate('sites')">Sites</span> / ${site.name}`,
      `<a href="/preview/${site.name}" target="_blank" class="btn btn-sm btn-secondary">👁 Preview</a>`
    );
    renderSiteContent();
  } catch (e) {
    setContent(`<div class="card"><p style="color:var(--red)">${e.message}</p></div>`);
  }
}

function renderSiteContent() {
  const site = currentSite;
  const tabs = ['overview', 'files', 'logs', 'settings'];
  const tabBar = tabs.map(t =>
    `<div class="tab ${currentSiteTab === t ? 'active' : ''}" onclick="switchSiteTab('${t}')">${t.charAt(0).toUpperCase() + t.slice(1)}</div>`
  ).join('');

  let body = '';
  switch (currentSiteTab) {
    case 'overview': body = siteOverviewTab(site); break;
    case 'files':    body = siteFilesTab(site); break;
    case 'logs':     body = siteLogsTab(site); break;
    case 'settings': body = siteSettingsTab(site); break;
  }

  setContent(`<div class="tabs">${tabBar}</div>${body}`);

  if (currentSiteTab === 'logs') loadLogs(site.id);
  if (currentSiteTab === 'files') loadFiles(site.id, '');
}

function switchSiteTab(tab) {
  currentSiteTab = tab;
  renderSiteContent();
}

function siteOverviewTab(site) {
  const dns = site.dns || {};
  const ssl = site.ssl || {};
  const isProcess = ['node', 'custom'].includes(site.runtime);

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      <div class="info-block">
        <div class="info-icon">🌐</div>
        <div class="info-text">
          <div class="info-label">Domain</div>
          <div class="info-value">${site.domain ? `<a href="http://${site.domain}" target="_blank">${site.domain}</a>` : '<span style="color:var(--muted)">Not set</span>'}</div>
        </div>
      </div>
      <div class="info-block">
        <div class="info-icon">⚙</div>
        <div class="info-text">
          <div class="info-label">Runtime</div>
          <div class="info-value">${runtimeBadge(site.runtime)}</div>
        </div>
      </div>
      <div class="info-block">
        <div class="info-icon">${dns.status === 'connected' ? '✅' : dns.status === 'propagating' ? '⏳' : '❌'}</div>
        <div class="info-text">
          <div class="info-label">DNS Status</div>
          <div class="info-value">${dnsBadge(dns.status)}</div>
          <div style="font-size:0.75rem;color:var(--muted);margin-top:2px">${dns.message || ''}</div>
        </div>
      </div>
      <div class="info-block">
        <div class="info-icon">${ssl.status === 'active' ? '🔒' : '🔓'}</div>
        <div class="info-text">
          <div class="info-label">SSL Certificate</div>
          <div class="info-value">${sslBadge(ssl.status)}</div>
          <div style="font-size:0.75rem;color:var(--muted);margin-top:2px">${ssl.message || ''}</div>
        </div>
      </div>
    </div>

    ${isProcess ? `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Process Control</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm btn-primary" onclick="processAction(${site.id}, 'start')">▶ Start</button>
          <button class="btn btn-sm btn-secondary" onclick="processAction(${site.id}, 'restart')">↺ Restart</button>
          <button class="btn btn-sm btn-danger" onclick="processAction(${site.id}, 'stop')">■ Stop</button>
        </div>
      </div>
      <div style="font-size:0.85rem;color:var(--muted)">
        Status: ${statusBadge(site.status)}
        ${site.port ? `&nbsp;&nbsp;Internal port: <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">${site.port}</code>` : ''}
      </div>
      ${site.start_command ? `<div style="margin-top:10px;font-size:0.8rem;color:var(--muted)">Command: <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">${site.start_command.replace('{PORT}', site.port)}</code></div>` : ''}
    </div>` : ''}

    ${site.domain && ssl.status === 'none' ? `
    <div class="card" style="border-color:var(--yellow)33">
      <div class="card-header">
        <span class="card-title">🔒 Issue SSL Certificate</span>
        <button class="btn btn-sm btn-primary" onclick="openSSLModal(${site.id})">Install SSL</button>
      </div>
      <p style="font-size:0.85rem;color:var(--muted)">Paste your certificate and private key to enable HTTPS.</p>
    </div>` : ''}

    <div class="card">
      <div class="card-header"><span class="card-title">Site Info</span></div>
      <table style="width:100%">
        <tr><td style="color:var(--muted);padding:6px 0;font-size:0.82rem">Site path</td><td style="font-size:0.82rem"><code>/opt/hosted-sites/${site.name}</code></td></tr>
        <tr><td style="color:var(--muted);padding:6px 0;font-size:0.82rem">Config</td><td style="font-size:0.82rem"><code>/etc/hostctl/sites/${site.name}.json</code></td></tr>
        <tr><td style="color:var(--muted);padding:6px 0;font-size:0.82rem">Log file</td><td style="font-size:0.82rem"><code>/var/log/hostctl/${site.name}.log</code></td></tr>
        <tr><td style="color:var(--muted);padding:6px 0;font-size:0.82rem">Created</td><td style="font-size:0.82rem">${formatDate(site.created_at)}</td></tr>
      </table>
    </div>
  `;
}

function siteFilesTab(site) {
  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">File Manager</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm btn-secondary" onclick="promptMkdir()">+ Folder</button>
          <button class="btn btn-sm btn-primary" onclick="triggerUpload()">↑ Upload</button>
        </div>
      </div>
      <div class="breadcrumb" id="fileBreadcrumb"></div>
      <input type="file" id="uploadInput" multiple style="display:none" onchange="handleUpload(this)">
      <div class="upload-zone" id="uploadZone" onclick="triggerUpload()" ondrop="handleDrop(event)" ondragover="event.preventDefault();this.classList.add('dragover')" ondragleave="this.classList.remove('dragover')">
        <div style="font-size:2rem">📁</div>
        <p>Drop files here or click to upload</p>
      </div>
      <div id="fileList" style="margin-top:8px"></div>
    </div>
  `;
}

function siteLogsTab(site) {
  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Application Logs</span>
        <button class="btn btn-sm btn-secondary" onclick="loadLogs(${site.id})">↺ Refresh</button>
      </div>
      <div class="logs-box" id="logsBox">Loading logs…</div>
    </div>
  `;
}

function siteSettingsTab(site) {
  const isProcess = ['node', 'custom'].includes(site.runtime);
  return `
    <div class="card">
      <div class="card-header"><span class="card-title">Site Settings</span></div>
      <div class="form-row">
        <div class="form-group">
          <label>Domain</label>
          <input type="text" id="settingDomain" value="${site.domain || ''}" placeholder="example.com" />
        </div>
        ${site.runtime === 'php' ? `
        <div class="form-group">
          <label>PHP Version</label>
          <select id="settingPhpVersion">
            <option value="8.1">PHP 8.1</option>
          </select>
        </div>` : '<div></div>'}
      </div>
      ${isProcess ? `
      <div class="form-row single">
        <div class="form-group">
          <label>Start Command</label>
          <input type="text" id="settingStartCmd" value="${site.start_command || ''}" placeholder="node app.js --port={PORT}" />
          <div class="form-hint">Must include <code>{PORT}</code></div>
        </div>
      </div>` : ''}
      <div style="display:flex;gap:10px;margin-top:8px">
        <button class="btn btn-primary" onclick="saveSiteSettings(${site.id})">Save Settings</button>
        ${currentUser.role === 'owner' ? `<button class="btn btn-danger" onclick="deleteSite(${site.id}, '${site.name}')">Delete Site</button>` : ''}
      </div>
    </div>
  `;
}

// ─── Users View ───────────────────────────────────────────────────────────────
async function renderUsers() {
  if (currentUser.role !== 'owner') { navigate('dashboard'); return; }
  setPage('User Management', `<button class="btn btn-primary" onclick="openModal('createUserModal')">+ New User</button>`);
  const users = await api.get('/users').catch(() => []);
  const sites = await api.get('/sites').catch(() => []);

  setContent(`
    <div class="card">
      <div class="card-header"><span class="card-title">Subusers</span></div>
      ${!users.length ? '<p style="color:var(--muted);padding:10px">No subusers yet.</p>' : `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Username</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            ${users.map(u => `
              <tr>
                <td><strong>${u.username}</strong></td>
                <td style="color:var(--muted)">${formatDateShort(u.created_at)}</td>
                <td>
                  <button class="btn btn-sm btn-secondary" onclick="openPermsModal(${u.id}, '${u.username}')">Permissions</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id}, '${u.username}')">Delete</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
  `);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function updateRuntimeFields() {
  const rt = document.getElementById('newSiteRuntime').value;
  document.getElementById('phpFields').style.display = rt === 'php' ? '' : 'none';
  document.getElementById('cmdFields').style.display = ['node', 'custom'].includes(rt) ? '' : 'none';
}

async function createSite() {
  const name = document.getElementById('newSiteName').value.trim();
  const domain = document.getElementById('newSiteDomain').value.trim();
  const runtime = document.getElementById('newSiteRuntime').value;
  const start_command = document.getElementById('newStartCmd')?.value.trim();
  const php_version = document.getElementById('newPhpVersion')?.value;
  if (!name) return toast.error('Site name is required');

  try {
    await api.post('/sites', { name, domain: domain || undefined, runtime, start_command, php_version });
    closeModal('createSiteModal');
    toast.success(`Site "${name}" created`);
    navigate(currentView === 'dashboard' ? 'dashboard' : 'sites');
  } catch (e) { toast.error(e.message); }
}

async function deleteSite(id, name) {
  if (!confirm(`Delete site "${name}"? This will remove all files and cannot be undone.`)) return;
  try {
    await api.delete(`/sites/${id}`);
    toast.success(`Site "${name}" deleted`);
    navigate('sites');
  } catch (e) { toast.error(e.message); }
}

async function processAction(siteId, action) {
  try {
    await api.post(`/sites/${siteId}/process/${action}`);
    toast.success(`Process ${action}ed`);
    const site = await api.get(`/sites/${siteId}`);
    currentSite = site;
    renderSiteContent();
  } catch (e) { toast.error(e.message); }
}

async function saveSiteSettings(siteId) {
  const domain = document.getElementById('settingDomain')?.value.trim();
  const start_command = document.getElementById('settingStartCmd')?.value.trim();
  const php_version = document.getElementById('settingPhpVersion')?.value;
  try {
    const updated = await api.patch(`/sites/${siteId}`, { domain: domain || null, start_command: start_command || null, php_version });
    currentSite = { ...currentSite, ...updated };
    toast.success('Settings saved');
  } catch (e) { toast.error(e.message); }
}

async function loadLogs(siteId) {
  const box = document.getElementById('logsBox');
  if (!box) return;
  box.textContent = 'Loading…';
  try {
    const data = await api.get(`/sites/${siteId}/logs?lines=200`);
    box.textContent = data.lines.length ? data.lines.join('\n') : '(no log output yet)';
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.textContent = `Error: ${e.message}`; }
}

// ─── File Manager ─────────────────────────────────────────────────────────────
let currentFilePath = '';

async function loadFiles(siteId, path) {
  currentFilePath = path;
  const listEl = document.getElementById('fileList');
  const crumbEl = document.getElementById('fileBreadcrumb');
  if (!listEl) return;

  listEl.innerHTML = '<div style="color:var(--muted);padding:8px">Loading…</div>';

  try {
    const data = await api.get(`/sites/${siteId}/files?path=${encodeURIComponent(path)}`);

    // Breadcrumb
    const parts = path.split('/').filter(Boolean);
    crumbEl.innerHTML = `<span class="breadcrumb-item" onclick="loadFiles(${siteId}, '')">root</span>`
      + parts.map((p, i) => {
          const partial = parts.slice(0, i + 1).join('/');
          return `<span class="breadcrumb-sep">/</span><span class="breadcrumb-item" onclick="loadFiles(${siteId}, '${partial}')">${p}</span>`;
        }).join('');

    // List
    const sorted = [...data.entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (!sorted.length) {
      listEl.innerHTML = '<div style="color:var(--muted);padding:12px;text-align:center">Empty directory</div>';
      return;
    }

    listEl.innerHTML = sorted.map(e => `
      <div class="file-row" onclick="${e.type === 'directory' ? `loadFiles(${siteId}, '${e.path}')` : `openEditor(${siteId}, '${e.path}')`}">
        <span class="file-icon">${e.type === 'directory' ? '📁' : fileIcon(e.name)}</span>
        <span class="file-name">${e.name}</span>
        <span class="file-date">${formatDateShort(e.modified)}</span>
        <span class="file-size">${e.type === 'file' ? formatBytes(e.size) : ''}</span>
        <div class="file-actions" onclick="event.stopPropagation()">
          <button class="btn btn-sm btn-danger btn-icon" title="Delete" onclick="deleteFile(${siteId}, '${e.path}', '${e.name}')">🗑</button>
        </div>
      </div>`).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--red);padding:8px">${e.message}</div>`;
  }
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = { html: '📄', htm: '📄', css: '🎨', js: '📜', json: '📋', php: '🐘', md: '📝', txt: '📝', sh: '⚙', py: '🐍', env: '🔒', png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', zip: '📦', tar: '📦', gz: '📦' };
  return map[ext] || '📄';
}

async function openEditor(siteId, filePath) {
  try {
    const data = await api.get(`/sites/${siteId}/files/read?path=${encodeURIComponent(filePath)}`);
    editorState = { siteId, path: filePath };
    document.getElementById('editorModalTitle').textContent = filePath.split('/').pop();
    document.getElementById('editorContent').value = data.content;
    openModal('editorModal');
  } catch (e) { toast.error(e.message); }
}

async function saveFile() {
  try {
    await api.put(`/sites/${editorState.siteId}/files/write`, {
      path: editorState.path,
      content: document.getElementById('editorContent').value,
    });
    toast.success('File saved');
    closeModal('editorModal');
  } catch (e) { toast.error(e.message); }
}

async function deleteFile(siteId, filePath, name) {
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    await api.delete(`/sites/${siteId}/files`, { path: filePath });
    toast.success(`"${name}" deleted`);
    loadFiles(siteId, currentFilePath);
  } catch (e) { toast.error(e.message); }
}

function triggerUpload() { document.getElementById('uploadInput')?.click(); }

async function handleUpload(input) {
  const files = [...input.files];
  if (!files.length) return;
  try {
    await api.upload(currentSite.id, currentFilePath, files);
    toast.success(`${files.length} file(s) uploaded`);
    loadFiles(currentSite.id, currentFilePath);
  } catch (e) { toast.error(e.message); }
  input.value = '';
}

async function handleDrop(e) {
  e.preventDefault();
  document.getElementById('uploadZone').classList.remove('dragover');
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  try {
    await api.upload(currentSite.id, currentFilePath, files);
    toast.success(`${files.length} file(s) uploaded`);
    loadFiles(currentSite.id, currentFilePath);
  } catch (e) { toast.error(e.message); }
}

async function promptMkdir() {
  const name = prompt('New folder name:');
  if (!name) return;
  try {
    await api.post(`/sites/${currentSite.id}/files/mkdir`, { path: [currentFilePath, name].filter(Boolean).join('/') });
    toast.success('Folder created');
    loadFiles(currentSite.id, currentFilePath);
  } catch (e) { toast.error(e.message); }
}

// ─── Users ────────────────────────────────────────────────────────────────────
async function createUser() {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newUserPassword').value;
  if (!username || !password) return toast.error('Username and password required');
  try {
    await api.post('/users', { username, password });
    closeModal('createUserModal');
    toast.success(`User "${username}" created`);
    renderUsers();
  } catch (e) { toast.error(e.message); }
}

async function deleteUser(id, name) {
  if (!confirm(`Delete user "${name}"?`)) return;
  try {
    await api.delete(`/users/${id}`);
    toast.success(`User "${name}" deleted`);
    renderUsers();
  } catch (e) { toast.error(e.message); }
}

async function openPermsModal(userId, username) {
  document.getElementById('permsModalTitle').textContent = `Permissions — ${username}`;
  const body = document.getElementById('permsModalBody');
  body.innerHTML = 'Loading…';
  openModal('permsModal');

  const [perms, sites] = await Promise.all([
    api.get(`/users/${userId}/permissions`).catch(() => []),
    api.get('/sites').catch(() => []),
  ]);

  const permMap = {};
  perms.forEach(p => { permMap[p.site_id] = p.permissions; });

  const ALL_PERMS = ['view', 'files', 'deploy', 'settings', 'admin'];

  body.innerHTML = sites.length ? sites.map(site => {
    const current = permMap[site.id] || [];
    return `
      <div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)">
        <div style="font-weight:600;margin-bottom:8px">${site.name} ${site.domain ? `<span style="color:var(--muted);font-size:0.8rem">${site.domain}</span>` : ''}</div>
        <div class="perm-grid">
          ${ALL_PERMS.map(p => `
            <label class="perm-toggle ${current.includes(p) ? 'selected' : ''}" id="pt-${userId}-${site.id}-${p}">
              <input type="checkbox" ${current.includes(p) ? 'checked' : ''} onchange="togglePerm(${userId}, ${site.id}, '${p}', this.checked)" />
              ${p}
            </label>`).join('')}
        </div>
      </div>`;
  }).join('') : '<p style="color:var(--muted)">No sites available.</p>';
}

async function togglePerm(userId, siteId, perm, checked) {
  const row = document.querySelector(`#pt-${userId}-${siteId}-${perm}`);
  try {
    const current = await api.get(`/users/${userId}/permissions`);
    const site = current.find(p => p.site_id === siteId);
    let perms = site ? [...site.permissions] : [];
    if (checked) { if (!perms.includes(perm)) perms.push(perm); }
    else perms = perms.filter(p => p !== perm);

    if (perms.length === 0) {
      await api.delete(`/users/${userId}/permissions/${siteId}`);
    } else {
      await api.put(`/users/${userId}/permissions/${siteId}`, { permissions: perms });
    }
    row?.classList.toggle('selected', checked);
  } catch (e) {
    row?.classList.toggle('selected', !checked); // revert
    toast.error(e.message);
  }
}

// ─── SSL ──────────────────────────────────────────────────────────────────────
function openSSLModal(siteId) {
  sslTargetSiteId = siteId;
  openModal('sslModal');
}

async function issueSSL() {
  const cert = document.getElementById('sslCert').value.trim();
  const key  = document.getElementById('sslKey').value.trim();
  if (!cert || !key) return toast.error('Certificate and private key are required');
  try {
    await api.post(`/sites/${sslTargetSiteId}/ssl`, { cert, key });
    toast.success('SSL certificate installed successfully');
    closeModal('sslModal');
    renderSite(sslTargetSiteId);
  } catch (e) { toast.error(e.message); }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function logout() {
  await api.post('/auth/logout').catch(() => {});
  window.location.href = '/login';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setPage(title, actionsHtml = '') {
  document.getElementById('pageTitle').innerHTML = title;
  document.getElementById('topbarActions').innerHTML = actionsHtml;
}

function setContent(html) {
  document.getElementById('mainContent').innerHTML = html;
}
