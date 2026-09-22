#!/usr/bin/env bash
# Push the static site and fetch helper to the Lightsail box.
#   web/backend/deploy/lightsail/deploy.sh [--setup]      (run from anywhere; --setup installs packages first)
# Env: SIGNAL_HOST (default 100.59.200.218, the 8 GB EC2 instance), SIGNAL_KEY (default ~/.ssh/id_ed25519)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
IP="${SIGNAL_HOST:-100.59.200.218}"
KEY="${SIGNAL_KEY:-$HOME/.ssh/id_ed25519}"
SITE_HOST="${IP//./-}.sslip.io"
SSH=(ssh -i "$KEY" -o ConnectTimeout=15 "ubuntu@$IP")

if [[ "${1:-}" == "--setup" ]]; then
  "${SSH[@]}" "SITE_HOST=$SITE_HOST bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v caddy >/dev/null; then
  sudo apt-get update -q
  sudo apt-get install -yq debian-keyring debian-archive-keyring apt-transport-https curl rsync
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -q && sudo apt-get install -yq caddy
fi
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -yq nodejs
fi
id signal >/dev/null 2>&1 || sudo useradd --system --home /opt/signal-helper --shell /usr/sbin/nologin signal
sudo mkdir -p /var/www/signal /opt/signal-helper/.cache
sudo chown -R ubuntu: /var/www/signal
sudo chown -R signal: /opt/signal-helper
# Only this line is ours; the Firecrawl key and the admin login live in the same file.
sudo touch /etc/default/caddy
sudo sed -i "/^SITE_HOST=/d" /etc/default/caddy
echo "SITE_HOST=$SITE_HOST" | sudo tee -a /etc/default/caddy >/dev/null
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/default/caddy\n' | sudo tee /etc/systemd/system/caddy.service.d/env.conf >/dev/null
if [[ ! -x /opt/signal-helper/obscura ]]; then
  cd /tmp && curl -fsSLO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-x86_64-linux.tar.gz
  mkdir -p obscura-x && tar xzf obscura-x86_64-linux.tar.gz -C obscura-x
  sudo install -o signal -m 755 $(find obscura-x -type f -name 'obscura*' -perm -u+x) /opt/signal-helper/
  rm -rf obscura-x obscura-x86_64-linux.tar.gz
fi
REMOTE
fi

# Static site: web/frontend only, the same folder Vercel publishes. download/ is excluded so
# --delete leaves the desktop builds below alone.
rsync -az --delete -e "ssh -i $KEY" \
  --exclude='download/' \
  "$ROOT/web/frontend/" "ubuntu@$IP:/var/www/signal/"

# Desktop builds, served at /download/. Build first: cd app/desktop && npx tauri build
BUNDLE="$ROOT/app/desktop/src-tauri/target/release/bundle"
"${SSH[@]}" 'mkdir -p /var/www/signal/download'
rsync -az --delete -e "ssh -i $KEY" \
  "$BUNDLE"/appimage/*.AppImage "$BUNDLE"/deb/*.deb "ubuntu@$IP:/var/www/signal/download/"

scp -q -i "$KEY" "$ROOT/web/backend/fetch-helper.mjs" "$ROOT/web/backend/deploy/lightsail/signal-helper.service" \
  "$ROOT/web/backend/deploy/lightsail/Caddyfile" "ubuntu@$IP:/tmp/"
"${SSH[@]}" 'set -e
sudo install -o signal -m 644 /tmp/fetch-helper.mjs /opt/signal-helper/fetch-helper.mjs
sudo install -m 644 /tmp/signal-helper.service /etc/systemd/system/signal-helper.service
# The admin login must exist for the config to load: until web/backend/deploy/admin/setup.sh sets a real one,
# use the hash of a random password that is thrown away (so /admin stays locked).
if ! sudo grep -q "^ADMIN_HASH=." /etc/default/caddy; then
  printf "ADMIN_USER=alphx\nADMIN_HASH=%s\n" "$(caddy hash-password --plaintext "$(openssl rand -hex 32)")" | sudo tee -a /etc/default/caddy >/dev/null
fi
sudo mkdir -p /var/log/caddy && sudo chown caddy: /var/log/caddy
# Never install a config Caddy would reject: the site would go down with it.
# (the env file is passed as plain words, never shell-expanded: the password hash is full of "$")
sudo env $(sudo grep "^[A-Z_]*=" /etc/default/caddy) caddy validate --config /tmp/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || { echo "Caddyfile is invalid; not installed." >&2; exit 1; }
# Validating as root creates the log file as root; Caddy must own it or it will not start.
sudo chown -R caddy: /var/log/caddy
sudo install -m 644 /tmp/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now signal-helper caddy >/dev/null 2>&1
sudo systemctl restart signal-helper
sudo systemctl reload caddy || sudo systemctl restart caddy
systemctl is-active signal-helper caddy'
echo "https://$SITE_HOST/"
