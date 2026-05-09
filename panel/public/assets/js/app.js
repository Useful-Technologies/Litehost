// ─── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let currentView = 'dashboard';
let currentSite = null;
let currentSiteTab = 'overview';
let editorState = { siteId: null, path: null };
let availableCerts = []; // cached cert list for dropdowns
let currentSites = [];   // cached sites list for process memory name resolution
let _systemPoller = null;

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
  stopSystemPoller();
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const navTarget = view === 'site' ? 'sites' : view;
  document.querySelector(`.nav-item[data-view="${navTarget}"]`)?.classList.add('active');

  switch (view) {
    case 'dashboard': renderDashboard(); break;
    case 'sites':     renderSitesList(); break;
    case 'site':      renderSite(siteId); break;
    case 'certs':     renderCerts(); break;
    case 'users':     renderUsers(); break;
  }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function renderDashboard() {
  setPage('Dashboard', currentUser.role === 'owner'
    ? `<button class="btn btn-primary" onclick="openModal('createSiteModal')">+ New Site</button>` : '');

  const sites = await api.get('/sites').catch(() => []);
  currentSites = sites;
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

    <div class="resource-grid">
      <div class="resource-card">
        <div class="resource-header">
          <span class="resource-label">CPU</span>
          <span class="resource-pct" id="resCpuPct">—</span>
        </div>
        <div class="resource-bar"><div class="resource-fill" id="resCpuBar" style="width:0%"></div></div>
        <div class="resource-sub" id="resCpuSub">Load: —</div>
      </div>
      <div class="resource-card">
        <div class="resource-header">
          <span class="resource-label">Memory</span>
          <span class="resource-pct" id="resRamPct">—</span>
        </div>
        <div class="resource-bar"><div class="resource-fill" id="resRamBar" style="width:0%"></div></div>
        <div class="resource-sub" id="resRamSub">— / —</div>
      </div>
      <div class="resource-card">
        <div class="resource-header">
          <span class="resource-label">Disk</span>
          <span class="resource-pct" id="resDiskPct">—</span>
        </div>
        <div class="resource-bar"><div class="resource-fill" id="resDiskBar" style="width:0%"></div></div>
        <div class="resource-sub" id="resDiskSub">— / —</div>
      </div>
      <div class="resource-card">
        <div class="resource-header">
          <span class="resource-label">Uptime</span>
          <span class="resource-pct" style="font-size:1rem" id="resUptime">—</span>
        </div>
        <div class="resource-bar" style="visibility:hidden"><div class="resource-fill" style="width:0%"></div></div>
        <div class="resource-sub" id="resUptimeSub">&nbsp;</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Process Memory</span>
        <span style="font-size:0.75rem;color:var(--muted)">RSS = actual RAM used by each process</span>
      </div>
      <div id="procMemBody" style="font-size:0.85rem;color:var(--muted);padding:4px 0">Loading…</div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">All Sites</span>
      </div>
      ${sitesTable(sites)}
    </div>
  `);

  startSystemPoller();
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
    const [site, certs] = await Promise.all([
      api.get(`/sites/${siteId}`),
      currentUser.role === 'owner' ? api.get('/certs').catch(() => []) : Promise.resolve([]),
    ]);
    currentSite = site;
    availableCerts = certs;
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

async function switchSiteTab(tab) {
  currentSiteTab = tab;
  if (tab === 'settings' && currentUser.role === 'owner') {
    availableCerts = await api.get('/certs').catch(() => []);
  }
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

    ${currentUser.role === 'owner' && site.domain ? `
    <div class="card" ${ssl.status === 'none' || ssl.status === 'expired' ? 'style="border-color:var(--yellow)33"' : ''}>
      <div class="card-header">
        <span class="card-title">🔒 SSL Certificate</span>
        <button class="btn btn-sm btn-secondary" onclick="switchSiteTab('settings')">Manage</button>
      </div>
      ${ssl.status !== 'none'
        ? `<p style="font-size:0.85rem;color:var(--muted)">${ssl.message || ''}</p>`
        : `<p style="font-size:0.85rem;color:var(--muted)">No certificate linked. Create one on the <a href="#" onclick="navigate('certs');return false">Certificates</a> page, then link it here in <a href="#" onclick="switchSiteTab('settings');return false">Settings</a>.</p>`}
    </div>` : ''}

    ${site.git_repo ? `
    <div class="card">
      <div class="card-header">
        <span class="card-title">🔗 Git Deploy</span>
        <div style="display:flex;gap:8px;align-items:center">
          ${site.git_auto_deploy
            ? `<span style="font-size:0.75rem;background:var(--green)22;color:var(--green);border:1px solid var(--green)44;padding:2px 8px;border-radius:10px">● Auto</span>`
            : ''}
          <button class="btn btn-sm btn-primary" onclick="gitDeploy(${site.id})">↓ Pull & Deploy</button>
        </div>
      </div>
      <table style="width:100%">
        <tr><td style="color:var(--muted);padding:6px 0;font-size:0.82rem">Repository</td><td style="font-size:0.82rem"><code>${site.git_repo}</code></td></tr>
        <tr><td style="color:var(--muted);padding:6px 0;font-size:0.82rem">Branch</td><td style="font-size:0.82rem"><code>${site.git_branch || 'main'}</code></td></tr>
        ${site.deploy_token ? `<tr><td style="color:var(--muted);padding:6px 0;font-size:0.82rem">Auto-deploy</td><td style="font-size:0.82rem"><span style="color:var(--green)">● GitHub Actions webhook ready</span></td></tr>` : ''}
      </table>
      <div id="gitDeployLog" style="display:none;margin-top:12px">
        <div class="logs-box" id="gitDeployOutput" style="max-height:200px"></div>
      </div>
    </div>` : `
    <div class="card" style="border-color:var(--border)">
      <div class="card-header">
        <span class="card-title">🔗 Git Deploy</span>
        <button class="btn btn-sm btn-secondary" onclick="switchSiteTab('settings')">Configure</button>
      </div>
      <p style="font-size:0.85rem;color:var(--muted)">Link a Git repository to enable one-click pull & deploy. Set it up in the Settings tab.</p>
    </div>`}

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

    <div class="card">
      <div class="card-header"><span class="card-title">🔗 Git Repository</span></div>
      <div class="form-row">
        <div class="form-group">
          <label>Repository URL</label>
          <input type="text" id="settingGitRepo" value="${site.git_repo || ''}" placeholder="https://github.com/user/repo.git" />
        </div>
        <div class="form-group">
          <label>Branch</label>
          <input type="text" id="settingGitBranch" value="${site.git_branch || 'main'}" placeholder="main" />
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn btn-primary" onclick="saveGitSettings(${site.id})">Save Git Settings</button>
      </div>
      ${site.deploy_token ? `
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
        <div style="font-weight:600;margin-bottom:4px;font-size:0.9rem">⚡ Auto-deploy via GitHub Webhook</div>
        <div class="form-hint" style="margin-bottom:14px">Go to your GitHub repo → <strong>Settings → Webhooks → Add webhook</strong>. Fill in the two fields below, set Content type to <code>application/json</code>, and choose <em>Just the push event</em>.</div>

        <div style="display:grid;gap:8px">
          <div>
            <label style="font-size:0.8rem;color:var(--muted);display:block;margin-bottom:4px">Payload URL</label>
            <div style="display:flex;gap:6px">
              <input type="text" id="deployWebhookUrl" value="${window.location.origin}/api/deploy/${site.deploy_token}" readonly
                style="flex:1;font-family:monospace;font-size:0.8rem;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 10px" />
              <button class="btn btn-sm btn-secondary" onclick="copyField('deployWebhookUrl')">Copy</button>
              <button class="btn btn-sm btn-secondary" onclick="rotateDeployToken(${site.id})" title="Regenerate URL token (invalidates old URL)">↺</button>
            </div>
          </div>
          <div>
            <label style="font-size:0.8rem;color:var(--muted);display:block;margin-bottom:4px">Secret</label>
            <div style="display:flex;gap:6px">
              <input type="text" id="deployWebhookSecret" value="${site.webhook_secret}" readonly
                style="flex:1;font-family:monospace;font-size:0.8rem;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 10px" />
              <button class="btn btn-sm btn-secondary" onclick="copyField('deployWebhookSecret')">Copy</button>
              <button class="btn btn-sm btn-secondary" onclick="rotateWebhookSecret(${site.id})" title="Regenerate secret (must update GitHub webhook)">↺</button>
            </div>
          </div>
        </div>
      </div>` : ''}
    </div>

    ${currentUser.role === 'owner' && site.domain ? `
    <div class="card">
      <div class="card-header"><span class="card-title">🔒 SSL Certificate</span></div>
      <div class="form-row single">
        <div class="form-group">
          <label>Linked Certificate</label>
          <select id="settingCertId">
            <option value="">— None —</option>
            ${availableCerts.map(c => `<option value="${c.id}" ${site.cert_id == c.id ? 'selected' : ''}>${c.name}${c.common_name ? ` (${c.common_name})` : ''}</option>`).join('')}
          </select>
          <div class="form-hint">Select a certificate to enable HTTPS. <a href="#" onclick="navigate('certs');return false">Manage certificates →</a></div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button class="btn btn-primary" onclick="saveSiteCert(${site.id})">Save SSL Settings</button>
      </div>
    </div>` : ''}
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

// ─── Git ──────────────────────────────────────────────────────────────────────
async function saveGitSettings(siteId) {
  const git_repo   = document.getElementById('settingGitRepo')?.value.trim();
  const git_branch = document.getElementById('settingGitBranch')?.value.trim() || 'main';
  try {
    const updated = await api.patch(`/sites/${siteId}`, { git_repo: git_repo || null, git_branch });
    currentSite = { ...currentSite, ...updated };
    toast.success('Git settings saved');
    // Refresh so the webhook URL updates with the new branch name
    renderSiteContent();
  } catch (e) { toast.error(e.message); }
}

function copyField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.value)
    .then(() => toast.success('Copied'))
    .catch(() => { el.select(); document.execCommand('copy'); toast.success('Copied'); });
}

async function rotateDeployToken(siteId) {
  if (!confirm('This regenerates the Payload URL. You\'ll need to update the webhook in GitHub. Continue?')) return;
  try {
    const data = await api.post(`/sites/${siteId}/rotate-deploy-token`);
    currentSite = { ...currentSite, deploy_token: data.deploy_token };
    renderSiteContent();
    toast.success('Payload URL regenerated — update your GitHub webhook');
  } catch (e) { toast.error(e.message); }
}

async function rotateWebhookSecret(siteId) {
  if (!confirm('This regenerates the secret. You\'ll need to update the webhook in GitHub. Continue?')) return;
  try {
    const data = await api.post(`/sites/${siteId}/rotate-webhook-secret`);
    currentSite = { ...currentSite, webhook_secret: data.webhook_secret };
    renderSiteContent();
    toast.success('Webhook secret regenerated — update your GitHub webhook');
  } catch (e) { toast.error(e.message); }
}

async function gitDeploy(siteId) {
  const logEl = document.getElementById('gitDeployLog');
  const outEl = document.getElementById('gitDeployOutput');
  if (logEl) { logEl.style.display = ''; outEl.textContent = 'Deploying…'; }
  try {
    const data = await api.post(`/sites/${siteId}/git/deploy`);
    if (outEl) outEl.textContent = data.log || 'Done.';
    toast.success('Deployed successfully');
  } catch (e) {
    if (outEl) outEl.textContent = e.log || e.message;
    toast.error('Deploy failed');
  }
}

// ─── Certificates ─────────────────────────────────────────────────────────────
async function renderCerts() {
  if (currentUser.role !== 'owner') { navigate('dashboard'); return; }
  setPage('SSL Certificates', `<button class="btn btn-primary" onclick="openModal('createCertModal')">+ Add Certificate</button>`);

  const certs = await api.get('/certs').catch(() => []);
  availableCerts = certs;

  setContent(`
    <div class="card">
      <div class="card-header"><span class="card-title">Certificates</span></div>
      ${!certs.length ? '<p style="color:var(--muted);padding:16px;text-align:center">No certificates yet — add one to enable HTTPS on your sites.</p>' : `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Name</th><th>Common Name</th><th>Status</th><th>Expires</th><th>Linked Sites</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${certs.map(c => `
              <tr>
                <td><strong>${c.name}</strong></td>
                <td style="color:var(--muted);font-size:0.85rem">${c.common_name || '—'}</td>
                <td>${sslBadge(c.status)}</td>
                <td style="font-size:0.82rem;color:var(--muted)">${c.expiry ? formatDateShort(c.expiry) : '—'}</td>
                <td style="font-size:0.82rem">${(c.linked_sites || []).map(s => `<a href="#" onclick="navigate('site',${s.id});return false">${s.name}</a>`).join(', ') || '<span style="color:var(--muted)">None</span>'}</td>
                <td>
                  <button class="btn btn-sm btn-danger" onclick="deleteCert(${c.id}, '${c.name}')">Delete</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
  `);
}

async function createCert() {
  const name = document.getElementById('newCertName').value.trim();
  const cert = document.getElementById('newCertPem').value.trim();
  const key  = document.getElementById('newCertKey').value.trim();
  if (!name || !cert || !key) return toast.error('Name, certificate, and private key are required');
  try {
    await api.post('/certs', { name, cert, key });
    toast.success(`Certificate "${name}" added`);
    closeModal('createCertModal');
    document.getElementById('newCertName').value = '';
    document.getElementById('newCertPem').value = '';
    document.getElementById('newCertKey').value = '';
    renderCerts();
  } catch (e) { toast.error(e.message); }
}

async function deleteCert(id, name) {
  if (!confirm(`Delete certificate "${name}"? Any sites using it will lose HTTPS.`)) return;
  try {
    await api.delete(`/certs/${id}`);
    toast.success(`Certificate "${name}" deleted`);
    renderCerts();
  } catch (e) { toast.error(e.message); }
}

async function saveSiteCert(siteId) {
  const cert_id = document.getElementById('settingCertId')?.value || null;
  try {
    const updated = await api.patch(`/sites/${siteId}`, { cert_id: cert_id ? parseInt(cert_id) : null });
    currentSite = { ...currentSite, ...updated };
    toast.success('SSL settings saved');
  } catch (e) { toast.error(e.message); }
}

// ─── System resource poller ───────────────────────────────────────────────────
function stopSystemPoller() {
  if (_systemPoller) { clearInterval(_systemPoller); _systemPoller = null; }
}

function startSystemPoller() {
  stopSystemPoller();
  async function tick() {
    let s;
    try { s = await api.get('/system/stats'); } catch { return; }

    // CPU
    if (s.cpu.percent !== null) {
      const pct = s.cpu.percent;
      const el = document.getElementById('resCpuPct'); if (el) el.textContent = pct + '%';
      const bar = document.getElementById('resCpuBar');
      if (bar) { bar.style.width = pct + '%'; bar.className = 'resource-fill' + fillClass(pct); }
      const sub = document.getElementById('resCpuSub');
      if (sub) sub.textContent = `Load: ${s.loadAvg['1m']} / ${s.loadAvg['5m']} / ${s.loadAvg['15m']}`;
    }

    // RAM
    const ramPct = Math.round(s.memory.used / s.memory.total * 100);
    const ramEl  = document.getElementById('resRamPct');  if (ramEl)  ramEl.textContent  = ramPct + '%';
    const ramBar = document.getElementById('resRamBar');
    if (ramBar) { ramBar.style.width = ramPct + '%'; ramBar.className = 'resource-fill' + fillClass(ramPct); }
    const ramSub = document.getElementById('resRamSub');
    if (ramSub) ramSub.textContent = fmtBytes(s.memory.used) + ' / ' + fmtBytes(s.memory.total);

    // Disk
    if (s.disk) {
      const diskPct = Math.round(s.disk.used / s.disk.total * 100);
      const diskEl  = document.getElementById('resDiskPct');  if (diskEl)  diskEl.textContent  = diskPct + '%';
      const diskBar = document.getElementById('resDiskBar');
      if (diskBar) { diskBar.style.width = diskPct + '%'; diskBar.className = 'resource-fill' + fillClass(diskPct); }
      const diskSub = document.getElementById('resDiskSub');
      if (diskSub) diskSub.textContent = fmtBytes(s.disk.used) + ' / ' + fmtBytes(s.disk.total);
    }

    // Uptime
    const uptimeEl = document.getElementById('resUptime');
    if (uptimeEl) uptimeEl.textContent = fmtUptime(s.uptime);

    // Process memory breakdown
    const procEl = document.getElementById('procMemBody');
    if (procEl && s.procs) {
      const p = s.procs.panel;

      // Litehost-managed processes (live, updated every 5 s)
      const managed = [
        `<div class="proc-mem-row">
          <span class="proc-mem-name">⚡ Panel (Node.js)</span>
          <span class="proc-mem-rss">${fmtBytes(p.rss)} RSS</span>
          <span class="proc-mem-heap">${fmtBytes(p.heapUsed)} / ${fmtBytes(p.heapTotal)} heap</span>
        </div>`,
      ];
      for (const site of s.procs.sites || []) {
        const siteName = currentSites.find(x => x.id === site.siteId)?.name || `site #${site.siteId}`;
        managed.push(`<div class="proc-mem-row">
          <span class="proc-mem-name">🌐 ${siteName}</span>
          <span class="proc-mem-rss">${fmtBytes(site.rss)} RSS</span>
          <span class="proc-mem-heap">pid ${site.pid}</span>
        </div>`);
      }

      // All top processes (updated every ~30 s) — shows what else is consuming RAM
      const topRows = (s.top || []).map(proc =>
        `<div class="proc-mem-row">
          <span class="proc-mem-name" style="color:var(--muted)">${proc.name}</span>
          <span class="proc-mem-rss">${fmtBytes(proc.rss)} RSS</span>
          <span class="proc-mem-heap">pid ${proc.pid}</span>
        </div>`
      ).join('');

      procEl.innerHTML = managed.join('') + (s.top?.length
        ? `<div style="margin:10px 0 6px;font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted)">All processes (top by RSS)</div>${topRows}`
        : '');
    }
  }

  tick();
  _systemPoller = setInterval(tick, 5000);
}

function fillClass(pct) {
  if (pct >= 90) return ' danger';
  if (pct >= 70) return ' warn';
  return '';
}

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576)    return (b / 1048576).toFixed(0)    + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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
