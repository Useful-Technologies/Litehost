#!/usr/bin/env bash
# ============================================================
#  Litehost — Full Install Script for Ubuntu 22.04 Minimal
#  Quick install: curl -fsSL https://raw.githubusercontent.com/Useful-Technologies/Litehost/main/install.sh | sudo bash
# ============================================================
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $*"; }
info() { echo -e "${BLUE}[→]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✗]${NC} $*"; exit 1; }
hr()   { echo -e "${BOLD}$(printf '─%.0s' {1..60})${NC}"; }

# ── Root check ──────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Run as root: sudo bash install.sh"

# ── OS check ────────────────────────────────────────────────
if ! grep -qi 'ubuntu 22' /etc/os-release 2>/dev/null; then
  warn "This script targets Ubuntu 22.04. Proceeding anyway..."
fi

hr
echo -e "${BOLD}  ⚡ Litehost Installer${NC}"
echo    "  Self-hosted control panel for Ubuntu 22.04"
hr
echo ""

# ── Config ──────────────────────────────────────────────────
PANEL_DIR="/opt/litehost/panel"
SITES_DIR="/opt/hosted-sites"
CONF_DIR="/etc/hostctl"
LOG_DIR="/var/log/hostctl"
PANEL_PORT="${PANEL_PORT:-3000}"
LITEHOST_USER="litehost"
LITEHOST_REPO="https://github.com/Useful-Technologies/Litehost"

# ── Source detection (supports curl | bash) ──────────────────
if [[ -n "${BASH_SOURCE[0]:-}" ]] && [[ -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SCRIPT_DIR=""
fi

if [[ -z "$SCRIPT_DIR" ]] || [[ ! -d "$SCRIPT_DIR/panel" ]]; then
  info "Downloading Litehost from GitHub…"
  apt-get install -y -qq git >/dev/null 2>&1
  TMP_CLONE=$(mktemp -d)
  trap 'rm -rf "$TMP_CLONE"' EXIT
  git clone --depth=1 "$LITEHOST_REPO" "$TMP_CLONE" >/dev/null 2>&1
  SCRIPT_DIR="$TMP_CLONE"
  log "Repository downloaded"
fi

# Detect public IP
info "Detecting public IP…"
SERVER_IP=$(curl -s --max-time 5 ifconfig.me \
  || curl -s --max-time 5 api.ipify.org \
  || hostname -I | awk '{print $1}')
log "Server IP: ${SERVER_IP}"

# ── Step 1: System update ────────────────────────────────────
hr; echo -e "${BOLD}Step 1: Updating system${NC}"; hr
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git unzip gnupg2 ca-certificates lsb-release \
  software-properties-common apt-transport-https \
  dnsutils bind9-dnsutils openssl ufw \
  build-essential iproute2
log "Base packages installed"

# ── Step 2: Nginx ────────────────────────────────────────────
hr; echo -e "${BOLD}Step 2: Installing Nginx${NC}"; hr
apt-get install -y -qq nginx
systemctl enable nginx
systemctl start nginx
log "Nginx installed and started"

# ── Step 3: PHP-FPM ─────────────────────────────────────────
hr; echo -e "${BOLD}Step 3: Installing PHP 8.1${NC}"; hr
apt-get install -y -qq \
  php8.1-fpm php8.1-cli php8.1-common php8.1-mysql php8.1-zip \
  php8.1-gd php8.1-mbstring php8.1-curl php8.1-xml php8.1-bcmath
systemctl enable php8.1-fpm
systemctl start  php8.1-fpm
log "PHP 8.1 FPM installed"

# ── Step 4: Node.js 20 LTS ───────────────────────────────────
hr; echo -e "${BOLD}Step 4: Installing Node.js 20 LTS${NC}"; hr
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
fi
log "Node.js $(node --version) installed"
log "npm $(npm --version) installed"

# ── Step 5: Certbot ──────────────────────────────────────────
hr; echo -e "${BOLD}Step 5: Installing Certbot${NC}"; hr
if ! command -v certbot &>/dev/null; then
  snap install --classic certbot >/dev/null 2>&1 || apt-get install -y -qq certbot python3-certbot-nginx
  ln -sf /snap/bin/certbot /usr/bin/certbot 2>/dev/null || true
fi
mkdir -p /var/www/letsencrypt/.well-known/acme-challenge
log "Certbot installed"

# ── Step 6: SQLite tools ─────────────────────────────────────
hr; echo -e "${BOLD}Step 6: Installing SQLite${NC}"; hr
apt-get install -y -qq sqlite3 libsqlite3-dev
log "SQLite3 installed"

# ── Step 7: System user ──────────────────────────────────────
hr; echo -e "${BOLD}Step 7: Creating system user${NC}"; hr
if ! id "$LITEHOST_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$LITEHOST_USER"
  log "User '${LITEHOST_USER}' created"
else
  log "User '${LITEHOST_USER}' already exists"
fi

# Add litehost to www-data group so nginx can read hosted site files
usermod -aG www-data "$LITEHOST_USER" || true
log "User '${LITEHOST_USER}' added to www-data group"

# ── Step 8: Directories ──────────────────────────────────────
hr; echo -e "${BOLD}Step 8: Creating directories${NC}"; hr
mkdir -p "$PANEL_DIR"
mkdir -p "$SITES_DIR"
mkdir -p "$CONF_DIR/sites"
mkdir -p "$LOG_DIR"
mkdir -p /etc/nginx/sites-available
mkdir -p /etc/nginx/sites-enabled
mkdir -p /tmp/litehost-uploads
mkdir -p /var/www/letsencrypt

# Sites dir: litehost owns it, nginx (www-data) needs read access
chown -R "${LITEHOST_USER}:www-data" "$SITES_DIR"
chmod -R 750 "$SITES_DIR"

# Config + log dirs: litehost owns, others cannot read (secrets inside)
chown -R "${LITEHOST_USER}:${LITEHOST_USER}" "$CONF_DIR" "$LOG_DIR" /tmp/litehost-uploads
chmod 750 "$CONF_DIR" "$LOG_DIR"

log "Directories created"

# ── Step 9: Copy panel files ─────────────────────────────────
hr; echo -e "${BOLD}Step 9: Installing panel${NC}"; hr

if [[ -d "$SCRIPT_DIR/panel" ]]; then
  cp -r "$SCRIPT_DIR/panel/." "$PANEL_DIR/"
  chown -R "${LITEHOST_USER}:${LITEHOST_USER}" "$PANEL_DIR"
  log "Panel files copied from $SCRIPT_DIR/panel"
else
  die "Panel source not found at $SCRIPT_DIR/panel"
fi

# ── Step 10: npm install ─────────────────────────────────────
hr; echo -e "${BOLD}Step 10: Installing Node.js dependencies${NC}"; hr
cd "$PANEL_DIR"
npm install --omit=dev --quiet
chown -R "${LITEHOST_USER}:${LITEHOST_USER}" "$PANEL_DIR/node_modules"
log "npm dependencies installed"

# ── Step 11: Environment config ──────────────────────────────
hr; echo -e "${BOLD}Step 11: Writing environment config${NC}"; hr
SESSION_SECRET=$(openssl rand -hex 32)

cat > "$CONF_DIR/litehost.env" <<EOF
PANEL_PORT=${PANEL_PORT}
SERVER_IP=${SERVER_IP}
DB_PATH=${CONF_DIR}/litehost.db
SESSION_SECRET=${SESSION_SECRET}
NODE_ENV=production
EOF

chmod 600 "$CONF_DIR/litehost.env"
chown "${LITEHOST_USER}:${LITEHOST_USER}" "$CONF_DIR/litehost.env"
log "Environment file written to ${CONF_DIR}/litehost.env"

# ── Step 12: Nginx panel config ──────────────────────────────
hr; echo -e "${BOLD}Step 12: Configuring Nginx${NC}"; hr

# Remove default nginx site
rm -f /etc/nginx/sites-enabled/default

# Grant litehost user write access to nginx site config dirs
chown -R "${LITEHOST_USER}:${LITEHOST_USER}" /etc/nginx/sites-available /etc/nginx/sites-enabled

cat > /etc/nginx/sites-available/litehost-panel.conf <<NGINXEOF
server {
    listen 80 default_server;
    server_name _;

    # Panel proxy (handles /preview/* too)
    location / {
        proxy_pass http://127.0.0.1:${PANEL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 60s;
    }

    # Let's Encrypt webroot challenge
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    access_log /var/log/nginx/litehost-panel.log;
    error_log  /var/log/nginx/litehost-panel-error.log;
}
NGINXEOF

ln -sf /etc/nginx/sites-available/litehost-panel.conf \
       /etc/nginx/sites-enabled/litehost-panel.conf

nginx -t && systemctl reload nginx
log "Nginx configured and reloaded"

# ── Step 13: Sudoers for nginx ───────────────────────────────
hr; echo -e "${BOLD}Step 13: Configuring sudoers${NC}"; hr
cat > /etc/sudoers.d/litehost <<SUDOEOF
# Litehost panel: allow nginx config test and reload without password
${LITEHOST_USER} ALL=(root) NOPASSWD: /usr/sbin/nginx -t
${LITEHOST_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx
SUDOEOF
chmod 440 /etc/sudoers.d/litehost
# Validate sudoers syntax
visudo -c -f /etc/sudoers.d/litehost >/dev/null
log "Sudoers configured"

# ── Step 14: Systemd service ─────────────────────────────────
hr; echo -e "${BOLD}Step 14: Installing systemd service${NC}"; hr

cat > /etc/systemd/system/litehost.service <<SVCEOF
[Unit]
Description=Litehost Control Panel
After=network.target nginx.service
Wants=network-online.target

[Service]
Type=simple
User=${LITEHOST_USER}
Group=${LITEHOST_USER}
WorkingDirectory=${PANEL_DIR}
ExecStart=/usr/bin/node ${PANEL_DIR}/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=litehost
EnvironmentFile=-${CONF_DIR}/litehost.env

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable litehost
systemctl start litehost
log "Litehost service started"

# Wait for panel to boot and create owner account
info "Waiting for panel to initialize…"
for i in {1..15}; do
  if curl -sf http://127.0.0.1:${PANEL_PORT}/api/health >/dev/null 2>&1; then
    log "Panel is up"
    break
  fi
  sleep 1
done

# ── Step 15: Certbot auto-renew ──────────────────────────────
hr; echo -e "${BOLD}Step 15: Setting up SSL auto-renewal${NC}"; hr

apt-get install -y -qq cron
systemctl enable cron
systemctl start cron

CRON_JOB="0 3 * * * certbot renew --quiet --webroot -w /var/www/letsencrypt && systemctl reload nginx"

EXISTING_CRON=$(crontab -l 2>/dev/null || echo "")
if echo "$EXISTING_CRON" | grep -qF "certbot renew"; then
  log "Certbot cron already configured"
else
  { echo "$EXISTING_CRON"; echo "$CRON_JOB"; } | crontab -
  log "Certbot cron renewal configured (daily at 03:00)"
fi

# ── Step 16: Firewall ────────────────────────────────────────
hr; echo -e "${BOLD}Step 16: Configuring UFW firewall${NC}"; hr

ufw allow 22/tcp >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

log "Firewall: SSH + HTTP/HTTPS allowed, all other ports blocked"

# ── Step 17: Log rotation ────────────────────────────────────
hr; echo -e "${BOLD}Step 17: Log rotation${NC}"; hr
cat > /etc/logrotate.d/litehost <<ROTEOF
${LOG_DIR}/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 ${LITEHOST_USER} ${LITEHOST_USER}
    sharedscripts
    postrotate
        systemctl kill -s USR1 nginx 2>/dev/null || true
    endscript
}
ROTEOF
log "Log rotation configured (14-day retention)"

# ── Done ─────────────────────────────────────────────────────
hr
echo ""
echo -e "${GREEN}${BOLD}  ✅ Litehost installation complete!${NC}"
echo ""
echo -e "  Panel URL:   ${BOLD}http://${SERVER_IP}/${NC}"
echo -e "  Service:     ${BOLD}systemctl status litehost${NC}"
echo -e "  Logs:        ${BOLD}journalctl -u litehost -f${NC}"
echo ""

CRED_FILE="$CONF_DIR/owner-credentials.txt"
if [[ -f "$CRED_FILE" ]]; then
  echo -e "${YELLOW}${BOLD}  ⚠  Owner credentials (change password after first login!):${NC}"
  while IFS= read -r line; do
    echo "     $line"
  done < "$CRED_FILE"
  echo ""
fi

hr
echo -e "  ${BLUE}Service commands:${NC}"
echo    "    systemctl start|stop|restart|status litehost"
echo    "    journalctl -u litehost -f"
echo ""
echo -e "  ${BLUE}Key paths:${NC}"
echo    "    Panel:  ${PANEL_DIR}"
echo    "    Sites:  ${SITES_DIR}"
echo    "    Config: ${CONF_DIR}"
echo    "    Logs:   ${LOG_DIR}"
hr
