const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ssl = require('./ssl');

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';

function siteConfPath(name) {
  return path.join(SITES_AVAILABLE, `litehost-${name}.conf`);
}

function siteEnabledPath(name) {
  return path.join(SITES_ENABLED, `litehost-${name}.conf`);
}

function sslBlock(certId) {
  return `
    ssl_certificate     /etc/hostctl/certs/${certId}/cert.pem;
    ssl_certificate_key /etc/hostctl/certs/${certId}/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;`;
}

function staticConfig(site, certId) {
  const root = `/opt/hosted-sites/${site.name}`;
  const serverName = site.domain;
  const listenLine = certId ? 'listen 443 ssl http2;' : 'listen 80;';
  const redirect = certId ? `
server {
    listen 80;
    server_name ${serverName};
    return 301 https://$host$request_uri;
}
` : '';

  return `${redirect}server {
    ${listenLine}
    server_name ${serverName};
${certId ? sslBlock(certId) : ''}
    root ${root};
    index index.html index.htm;

    location / {
        try_files $uri $uri/ /index.html;
    }

    access_log /var/log/hostctl/${site.name}-access.log;
    error_log  /var/log/hostctl/${site.name}-error.log;
}`.trim();
}

function phpConfig(site, certId) {
  const root = `/opt/hosted-sites/${site.name}`;
  const serverName = site.domain;
  const phpVer = site.php_version || '8.1';
  const listenLine = certId ? 'listen 443 ssl http2;' : 'listen 80;';
  const redirect = certId ? `
server {
    listen 80;
    server_name ${serverName};
    return 301 https://$host$request_uri;
}
` : '';

  return `${redirect}server {
    ${listenLine}
    server_name ${serverName};
${certId ? sslBlock(certId) : ''}
    root ${root};
    index index.php index.html;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php${phpVer}-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        include fastcgi_params;
    }

    access_log /var/log/hostctl/${site.name}-access.log;
    error_log  /var/log/hostctl/${site.name}-error.log;
}`.trim();
}

function proxyConfig(site, certId) {
  const serverName = site.domain;
  const listenLine = certId ? 'listen 443 ssl http2;' : 'listen 80;';
  const redirect = certId ? `
server {
    listen 80;
    server_name ${serverName};
    return 301 https://$host$request_uri;
}
` : '';

  return `${redirect}server {
    ${listenLine}
    server_name ${serverName};
${certId ? sslBlock(certId) : ''}
    location / {
        proxy_pass http://127.0.0.1:${site.port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
    }

    access_log /var/log/hostctl/${site.name}-access.log;
    error_log  /var/log/hostctl/${site.name}-error.log;
}`.trim();
}

// Derive certId from site — only use cert if the files actually exist on disk
function resolveCertId(site) {
  if (!site.cert_id) return null;
  return ssl.hasCertificate(site.cert_id) ? site.cert_id : null;
}

function generateConfig(site) {
  const certId = resolveCertId(site);
  switch (site.runtime) {
    case 'static': return staticConfig(site, certId);
    case 'php':    return phpConfig(site, certId);
    case 'node':
    case 'custom': return proxyConfig(site, certId);
    default:       return staticConfig(site, certId);
  }
}

function writeSiteConfig(site) {
  // Sites with no domain can't be routed — skip nginx entirely
  if (!site.domain) return;

  fs.mkdirSync(SITES_AVAILABLE, { recursive: true });
  fs.mkdirSync(SITES_ENABLED, { recursive: true });
  fs.mkdirSync('/var/log/hostctl', { recursive: true });

  const conf = generateConfig(site);
  fs.writeFileSync(siteConfPath(site.name), conf, 'utf8');

  // Always recreate the symlink — a stale pointer silently serves the wrong site
  const enabled = siteEnabledPath(site.name);
  try { fs.unlinkSync(enabled); } catch {}
  fs.symlinkSync(siteConfPath(site.name), enabled);
}

function removeSiteConfig(name) {
  try { fs.unlinkSync(siteEnabledPath(name)); } catch {}
  try { fs.unlinkSync(siteConfPath(name)); } catch {}
}

function reloadNginx() {
  try {
    execSync('sudo nginx -t', { stdio: 'pipe' });
    execSync('sudo systemctl reload nginx', { stdio: 'pipe' });
    return { success: true };
  } catch (err) {
    const msg = err.stderr?.toString() || err.message;
    console.error('Nginx reload failed:', msg);
    return { success: false, error: msg };
  }
}

// Called after a cert is linked to a site — writeSiteConfig now reads cert_id automatically
function enableHTTPS(site) {
  if (!site.domain) return false;
  writeSiteConfig(site);
  return true;
}

const PANEL_CERT_DIR = '/etc/hostctl/panel-cert';

// Generate a self-signed cert for the panel's default_server block if one
// doesn't exist yet.  This lets nginx answer port 443 for unmatched hosts
// (e.g. via Cloudflare Full SSL) instead of falling through to a real site.
function ensurePanelCert() {
  const certFile = `${PANEL_CERT_DIR}/cert.pem`;
  const keyFile  = `${PANEL_CERT_DIR}/key.pem`;
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) return { certFile, keyFile };
  fs.mkdirSync(PANEL_CERT_DIR, { recursive: true, mode: 0o700 });
  execSync(
    `openssl req -x509 -nodes -newkey rsa:2048` +
    ` -keyout ${keyFile} -out ${certFile}` +
    ` -days 3650 -subj '/CN=litehost-panel'`,
    { stdio: 'pipe' }
  );
  return { certFile, keyFile };
}

// Write /etc/nginx/conf.d/litehost.conf — the catch-all default_server that
// forwards any unrecognised Host to the panel itself on both port 80 and 443.
// Without a 443 default_server, nginx uses the first real site with listen 443
// as the implicit default, meaning unmatched subdomains (e.g. panel.example.com
// via Cloudflare Full SSL) silently serve the wrong site.
function writeDefaultConfig() {
  const panelPort = process.env.PANEL_PORT || 3000;
  const { certFile, keyFile } = ensurePanelCert();

  const conf = `# Managed by Litehost — do not edit manually
server_names_hash_bucket_size 128;

server {
    listen 80  default_server;
    listen [::]:80  default_server;
    listen 443 ssl  default_server;
    listen [::]:443 ssl default_server;
    server_name _;

    ssl_certificate     ${certFile};
    ssl_certificate_key ${keyFile};
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass         http://127.0.0.1:${panelPort};
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
`;
  fs.writeFileSync('/etc/nginx/conf.d/litehost.conf', conf, 'utf8');
}

module.exports = { writeSiteConfig, removeSiteConfig, reloadNginx, enableHTTPS, generateConfig, writeDefaultConfig };
