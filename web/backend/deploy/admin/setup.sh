#!/usr/bin/env bash
# Admin statistics at https://<site>/admin: GoAccess over Caddy's (IP-masked) access log.
#   web/backend/deploy/admin/setup.sh [--new-password]    (run after web/backend/deploy/lightsail/deploy.sh)
# The password is made on the server, stored there only as a bcrypt hash, and printed once.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
IP="${SIGNAL_HOST:-100.59.200.218}"
KEY="${SIGNAL_KEY:-$HOME/.ssh/id_ed25519}"
ADMIN_USER="${ADMIN_USER:-alphx}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=15 "ubuntu@$IP")

scp -q -i "$KEY" "$ROOT/web/backend/deploy/admin/signal-stats.service" "$ROOT/web/backend/deploy/admin/signal-stats.timer" "ubuntu@$IP:/tmp/"
"${SSH[@]}" "ADMIN_USER=$ADMIN_USER NEWPW=${1:-} bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
command -v goaccess >/dev/null || { sudo apt-get update -q; sudo apt-get install -yq goaccess; }
sudo mkdir -p /var/www/admin /var/lib/signal-stats /var/log/caddy
sudo chown caddy: /var/log/caddy
sudo install -m 644 /tmp/signal-stats.service /tmp/signal-stats.timer /etc/systemd/system/
sudo systemctl daemon-reload
PW=""
if [[ "$NEWPW" == "--new-password" ]] || ! sudo grep -q "^ADMIN_HASH=." /etc/default/caddy; then
  PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  HASH="$(caddy hash-password --plaintext "$PW")"
  sudo sed -i "/^ADMIN_USER=/d; /^ADMIN_HASH=/d" /etc/default/caddy
  printf 'ADMIN_USER=%s\nADMIN_HASH=%s\n' "$ADMIN_USER" "$HASH" | sudo tee -a /etc/default/caddy >/dev/null
  sudo systemctl restart caddy
fi
# An empty report until the first requests are counted.
[[ -s /var/log/caddy/access.log ]] || echo '<!doctype html><title>Signal stats</title><p style="font-family:sans-serif">No visits counted yet. The report refreshes every 5 minutes.</p>' | sudo tee /var/www/admin/index.html >/dev/null
sudo systemctl enable --now signal-stats.timer >/dev/null
[[ -s /var/log/caddy/access.log ]] && sudo systemctl start signal-stats.service || true
systemctl is-active caddy signal-stats.timer
if [[ -n "$PW" ]]; then echo "ADMIN LOGIN: $ADMIN_USER / $PW"; fi
REMOTE
