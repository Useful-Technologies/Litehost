const fs = require('fs');
const { execSync } = require('child_process');

const CERT_DIR = '/etc/hostctl/certs';

function certPath(domain) { return `${CERT_DIR}/${domain}/cert.pem`; }
function keyPath(domain)  { return `${CERT_DIR}/${domain}/key.pem`; }

function hasCertificate(domain) {
  return fs.existsSync(certPath(domain)) && fs.existsSync(keyPath(domain));
}

function getCertExpiry(domain) {
  try {
    const result = execSync(
      `openssl x509 -enddate -noout -in ${certPath(domain)}`,
      { stdio: 'pipe' }
    ).toString().trim();
    const match = result.match(/notAfter=(.+)/);
    return match ? new Date(match[1]) : null;
  } catch {
    return null;
  }
}

function wrapKey(key) {
  const trimmed = key.trim();
  if (trimmed.startsWith('-----')) return trimmed + '\n';
  return `-----BEGIN PRIVATE KEY-----\n${trimmed}\n-----END PRIVATE KEY-----\n`;
}

function installCert(domain, cert, key) {
  const dir = `${CERT_DIR}/${domain}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(certPath(domain), cert.trim() + '\n', { mode: 0o600 });
  fs.writeFileSync(keyPath(domain),  wrapKey(key),        { mode: 0o600 });
}

function getSSLStatus(domain) {
  if (!domain) return { status: 'none', message: 'No domain set' };
  if (!hasCertificate(domain)) return { status: 'none', message: 'No certificate installed' };

  const expiry = getCertExpiry(domain);
  const now = new Date();
  const daysLeft = expiry ? Math.floor((expiry - now) / 86400000) : 0;

  if (daysLeft < 0) return { status: 'expired', message: 'Certificate expired', expiry };
  if (daysLeft < 14) return { status: 'expiring', message: `Expires in ${daysLeft} days`, expiry, daysLeft };
  return { status: 'active', message: `Valid for ${daysLeft} days`, expiry, daysLeft };
}

module.exports = { hasCertificate, installCert, getSSLStatus };
