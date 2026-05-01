const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';

function siteConfPath(name) {
  return path.join(SITES_AVAILABLE, `litehost-${name}.conf`);
}

function siteEnabledPath(name) {
  return path.join(SITES_ENABLED, `litehost-${name}.conf`);
}

function sslBlock(domain) {
  return `
    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;`;
}

function acmeLocation() {
  return `
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }`;
}

function staticConfig(site, withSSL) {
  const root = `/opt/hosted-sites/${site.name}`;
  const serverName = site.domain || '_';
  const listenLine = withSSL ? 'listen 443 ssl http2;' : 'listen 80;';
  const redirect = withSSL ? `
server {
    listen 80;
    server_name ${serverName};
    return 301 https://$host$request_uri;
}
` : '';

  return `${redirect}server {
    ${listenLine}
    server_name ${serverName};
${withSSL ? sslBlock(site.domain) : ''}
    root ${root};
    index index.html index.htm;

    location / {
        try_files $uri $uri/ /index.html;
    }
${acmeLocation()}
    access_log /var/log/hostctl/${site.name}-access.log;
    error_log  /var/log/hostctl/${site.name}-error.log;
}`.trim();
}

function phpConfig(site, withSSL) {
  const root = `/opt/hosted-sites/${site.name}`;
  const serverName = site.domain || '_';
  const phpVer = site.php_version || '8.1';
  const listenLine = withSSL ? 'listen 443 ssl http2;' : 'listen 80;';
  const redirect = withSSL ? `
server {
    listen 80;
    server_name ${serverName};
    return 301 https://$host$request_uri;
}
` : '';

  return `${redirect}server {
    ${listenLine}
    server_name ${serverName};
${withSSL ? sslBlock(site.domain) : ''}
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
${acmeLocation()}
    access_log /var/log/hostctl/${site.name}-access.log;
    error_log  /var/log/hostctl/${site.name}-error.log;
}`.trim();
}

function proxyConfig(site, withSSL) {
  const serverName = site.domain || '_';
  const listenLine = withSSL ? 'listen 443 ssl http2;' : 'listen 80;';
  const redirect = withSSL ? `
server {
    listen 80;
    server_name ${serverName};
    return 301 https://$host$request_uri;
}
` : '';

  return `${redirect}server {
    ${listenLine}
    server_name ${serverName};
${withSSL ? sslBlock(site.domain) : ''}
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
${acmeLocation()}
    access_log /var/log/hostctl/${site.name}-access.log;
    error_log  /var/log/hostctl/${site.name}-error.log;
}`.trim();
}

function generateConfig(site, withSSL = false) {
  switch (site.runtime) {
    case 'static': return staticConfig(site, withSSL);
    case 'php':    return phpConfig(site, withSSL);
    case 'node':
    case 'custom': return proxyConfig(site, withSSL);
    default:       return staticConfig(site, withSSL);
  }
}

function writeSiteConfig(site, withSSL = false) {
  fs.mkdirSync(SITES_AVAILABLE, { recursive: true });
  fs.mkdirSync(SITES_ENABLED, { recursive: true });
  fs.mkdirSync('/var/log/hostctl', { recursive: true });

  const conf = generateConfig(site, withSSL);
  fs.writeFileSync(siteConfPath(site.name), conf, 'utf8');

  const enabled = siteEnabledPath(site.name);
  if (!fs.existsSync(enabled)) {
    fs.symlinkSync(siteConfPath(site.name), enabled);
  }
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

// Called when SSL cert is ready — regenerate config with SSL blocks
function enableHTTPS(site) {
  if (!site.domain) return false;
  writeSiteConfig(site, true);
  return true;
}

module.exports = { writeSiteConfig, removeSiteConfig, reloadNginx, enableHTTPS, generateConfig };
