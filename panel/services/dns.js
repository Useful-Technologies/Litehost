const { execSync } = require('child_process');
const os = require('os');

function getServerIP() {
  return process.env.SERVER_IP || detectPublicIP();
}

function detectPublicIP() {
  try {
    const result = execSync("curl -s --max-time 3 ifconfig.me || curl -s --max-time 3 api.ipify.org", {
      stdio: 'pipe'
    }).toString().trim();
    return result || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

function resolveDomain(domain) {
  try {
    const result = execSync(`dig +short A ${domain} @1.1.1.1`, {
      stdio: 'pipe',
      timeout: 5000
    }).toString().trim();
    return result.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function checkDNS(domain) {
  const serverIP = getServerIP();
  const resolved = resolveDomain(domain);

  if (!resolved.length) {
    return { status: 'not_pointing', message: 'Domain has no A record', serverIP, resolved: [] };
  }

  if (resolved.includes(serverIP)) {
    return { status: 'connected', message: 'Domain points to this server', serverIP, resolved };
  }

  return { status: 'propagating', message: 'Domain resolves to different IP', serverIP, resolved };
}

module.exports = { checkDNS, getServerIP, detectPublicIP };
