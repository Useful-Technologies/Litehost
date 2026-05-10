const fs = require('fs');
const { execSync } = require('child_process');

const CERT_DIR = '/etc/hostctl/certs';

function certPath(id) { return `${CERT_DIR}/${id}/cert.pem`; }
function keyPath(id)  { return `${CERT_DIR}/${id}/key.pem`; }

function hasCertificate(id) {
  return fs.existsSync(certPath(id)) && fs.existsSync(keyPath(id));
}

function parseCert(certPem) {
  try {
    const out = execSync('openssl x509 -noout -subject -enddate', {
      input: certPem, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const cn      = out.match(/CN\s*=\s*([^,\n/]+)/);
    const expires = out.match(/notAfter=(.+)/);
    return {
      commonName: cn      ? cn[1].trim()                    : null,
      expiresAt:  expires ? new Date(expires[1]).toISOString() : null,
    };
  } catch { return { commonName: null, expiresAt: null }; }
}

function wrapKey(key) {
  const t = key.trim();
  if (t.startsWith('-----')) return t + '\n';
  return `-----BEGIN PRIVATE KEY-----\n${t}\n-----END PRIVATE KEY-----\n`;
}

function installCert(id, cert, key) {
  const dir = `${CERT_DIR}/${id}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 }); // nginx must traverse
  fs.writeFileSync(certPath(id), cert.trim() + '\n', { mode: 0o644 }); // nginx reads cert
  fs.writeFileSync(keyPath(id),  wrapKey(key),        { mode: 0o600 }); // private key stays locked
}

function removeCert(id) {
  try { fs.rmSync(`${CERT_DIR}/${id}`, { recursive: true, force: true }); } catch {}
}

function getSSLStatus(certId) {
  if (!certId) return { status: 'none', message: 'No certificate linked' };
  if (!hasCertificate(certId)) return { status: 'none', message: 'Certificate files missing' };
  try {
    const out = execSync(`openssl x509 -enddate -noout -in ${certPath(certId)}`, { stdio: 'pipe' }).toString();
    const match = out.match(/notAfter=(.+)/);
    const expiry = match ? new Date(match[1]) : null;
    const daysLeft = expiry ? Math.floor((expiry - new Date()) / 86400000) : 0;
    if (daysLeft < 0)  return { status: 'expired',  message: 'Certificate expired',          expiry, daysLeft };
    if (daysLeft < 14) return { status: 'expiring', message: `Expires in ${daysLeft} days`,  expiry, daysLeft };
    return                    { status: 'active',   message: `Valid for ${daysLeft} days`,   expiry, daysLeft };
  } catch { return { status: 'none', message: 'Could not read certificate' }; }
}

module.exports = { hasCertificate, installCert, removeCert, parseCert, getSSLStatus, certPath, keyPath };
