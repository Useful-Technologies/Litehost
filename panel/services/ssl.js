const { execSync, exec } = require('child_process');
const fs = require('fs');

function hasCertificate(domain) {
  const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  return fs.existsSync(certPath);
}

function getCertExpiry(domain) {
  try {
    const result = execSync(
      `openssl x509 -enddate -noout -in /etc/letsencrypt/live/${domain}/fullchain.pem`,
      { stdio: 'pipe' }
    ).toString().trim();
    const match = result.match(/notAfter=(.+)/);
    return match ? new Date(match[1]) : null;
  } catch {
    return null;
  }
}

function issueCert(domain, email) {
  return new Promise((resolve, reject) => {
    const cmd = [
      'certbot certonly',
      '--webroot',
      `-w /var/www/letsencrypt`,
      `-d ${domain}`,
      `--email ${email}`,
      '--agree-tos',
      '--non-interactive',
      '--quiet',
    ].join(' ');

    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ success: true, domain });
    });
  });
}

function enableHTTPS(site) {
  const siteConfPath = `/etc/nginx/sites-available/litehost-${site.name}.conf`;
  if (!fs.existsSync(siteConfPath)) return false;

  let conf = fs.readFileSync(siteConfPath, 'utf8');
  if (conf.includes('listen 443')) return true;

  const httpsBlock = `
server {
    listen 443 ssl http2;
    server_name ${site.domain};

    ssl_certificate     /etc/letsencrypt/live/${site.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${site.domain}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    ${conf.match(/location \/ \{[\s\S]+?\}/)?.[0] || 'location / { return 200; }'}
}
`;

  const withRedirect = conf.replace(
    /listen 80;/,
    `listen 80;\n    return 301 https://$host$request_uri;`
  );

  fs.writeFileSync(siteConfPath, withRedirect + '\n' + httpsBlock, 'utf8');
  return true;
}

function getSSLStatus(domain) {
  if (!domain) return { status: 'none', message: 'No domain set' };
  if (!hasCertificate(domain)) return { status: 'none', message: 'No certificate issued' };

  const expiry = getCertExpiry(domain);
  const now = new Date();
  const daysLeft = expiry ? Math.floor((expiry - now) / 86400000) : 0;

  if (daysLeft < 0) return { status: 'expired', message: 'Certificate expired', expiry };
  if (daysLeft < 14) return { status: 'expiring', message: `Expires in ${daysLeft} days`, expiry, daysLeft };
  return { status: 'active', message: `Valid for ${daysLeft} days`, expiry, daysLeft };
}

module.exports = { hasCertificate, issueCert, enableHTTPS, getSSLStatus };
