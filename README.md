# ⚡ Litehost

A lightweight, self-hosted web control panel for Ubuntu 22.04. Host and manage multiple websites — static, PHP, Node.js, or custom — from a clean web dashboard. No Docker, no cloud fees, no bloat.

---

## Features

- **Multi-runtime hosting** — static files, PHP 8.1, Node.js 20, or any custom process
- **Automatic SSL** — Let's Encrypt certificates issued and renewed automatically
- **File manager** — Upload, edit, and delete site files directly from the browser
- **Process control** — Start, stop, and restart Node.js and custom apps
- **User management** — Owner account plus unlimited sub-users with per-site permissions
- **DNS verification** — Confirms domain points to your server before issuing SSL
- **Activity log** — Full audit trail of actions across users and sites
- **Nginx integration** — Reverse proxy config generated automatically per site
- **Firewall setup** — UFW configured on install (SSH + HTTP/HTTPS only)

---

## Requirements

| | |
|---|---|
| **OS** | Ubuntu 22.04 LTS (minimal install recommended) |
| **RAM** | 512 MB minimum, 1 GB+ recommended |
| **Disk** | 2 GB free |
| **Access** | Root or sudo |
| **Network** | Public IP with ports 22, 80, and 443 open |

---

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/Useful-Technologies/Litehost/main/install.sh | sudo bash
```

That's it. The installer handles everything — dependencies, Nginx, PHP, Node.js, SSL tooling, systemd service, and firewall rules.

> **Running on a fresh VPS?** The one-liner above is all you need.

### What the installer does

1. Updates system packages
2. Installs Nginx, PHP 8.1-FPM, Node.js 20 LTS, Certbot, and SQLite3
3. Creates a dedicated `litehost` system user
4. Copies the panel to `/opt/litehost/panel` and installs dependencies
5. Writes a secure environment config to `/etc/hostctl/litehost.env`
6. Configures Nginx as a reverse proxy for the panel
7. Installs and starts the `litehost` systemd service
8. Sets up daily SSL certificate renewal via cron
9. Enables UFW and allows SSH + HTTP/HTTPS traffic
10. Configures log rotation with 14-day retention

Installation typically takes 2–5 minutes depending on your connection and VPS speed.

---

## First Login

When installation completes, the terminal prints:

```
  Panel URL:   http://<your-server-ip>/
```

Open that URL in your browser. Your initial **owner credentials** are displayed at the end of the install output, and also saved to `/etc/hostctl/owner-credentials.txt`.

> **Change your password immediately after first login.**

---

## Adding Your First Site

1. Log in to the dashboard
2. Click **New Site**
3. Enter a name and your domain (e.g. `example.com`)
4. Choose a runtime: **Static**, **PHP**, **Node.js**, or **Custom**
5. Point your domain's DNS A record to your server IP
6. Once DNS propagates, click **Issue SSL** to get a free certificate

---

## User Management

The owner account can create sub-users and assign per-site permissions:

| Permission | What it allows |
|---|---|
| `view` | See the site in the dashboard |
| `files` | Access the file manager |
| `deploy` | Start / stop / restart processes |
| `settings` | Edit site configuration |
| `admin` | Full control, including deleting the site |

---

## Service Management

```bash
# Status
systemctl status litehost

# Start / stop / restart
systemctl start litehost
systemctl stop litehost
systemctl restart litehost

# Live logs
journalctl -u litehost -f
```

---

## Key Paths

| Path | Purpose |
|---|---|
| `/opt/litehost/panel` | Panel application |
| `/opt/hosted-sites` | Site files |
| `/etc/hostctl` | Config and database |
| `/etc/hostctl/litehost.env` | Environment variables |
| `/etc/hostctl/litehost.db` | SQLite database |
| `/var/log/hostctl` | Application logs |
| `/etc/nginx/sites-available` | Nginx configs (one per site) |

---

## Configuration

The panel reads environment variables from `/etc/hostctl/litehost.env`:

```env
PANEL_PORT=3000         # Internal port the Node process listens on
SERVER_IP=...           # Auto-detected public IP
DB_PATH=...             # SQLite database path
SESSION_SECRET=...      # Auto-generated random secret
NODE_ENV=production
```

To change the panel port, edit the file and restart the service:

```bash
sudo nano /etc/hostctl/litehost.env
sudo systemctl restart litehost
```

---

## Uninstall

```bash
sudo systemctl stop litehost
sudo systemctl disable litehost
sudo rm -f /etc/systemd/system/litehost.service
sudo systemctl daemon-reload

sudo rm -rf /opt/litehost /opt/hosted-sites /etc/hostctl /var/log/hostctl
sudo rm -f /etc/nginx/sites-available/litehost-panel.conf \
           /etc/nginx/sites-enabled/litehost-panel.conf
sudo rm -f /etc/sudoers.d/litehost /etc/logrotate.d/litehost

sudo userdel litehost
sudo systemctl reload nginx
```

---

## License

MIT — do whatever you want with it.
