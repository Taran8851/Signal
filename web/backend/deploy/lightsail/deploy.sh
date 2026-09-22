#!/usr/bin/env bash
# Push the static site and fetch helper to the Lightsail box.
#   deploy/lightsail/deploy.sh [--setup]      (run from anywhere; --setup installs packages first)
# Env: SIGNAL_HOST (default 3.110.178.244), SIGNAL_KEY (default ./LightsailDefaultKey-ap-south-1.pem)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IP="${SIGNAL_HOST:-3.110.178.244}"
KEY="${SIGNAL_KEY:-$ROOT/LightsailDefaultKey-ap-south-1.pem}"
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
echo "SITE_HOST=$SITE_HOST" | sudo tee /etc/default/caddy >/dev/null
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

# Static site: same set Vercel publishes (see .vercelignore), never keys or tooling.
rsync -az --delete -e "ssh -i $KEY" \
  --exclude-from="$ROOT/.vercelignore" \
  --exclude='.git/' --exclude='.gitignore' --exclude='tools/' --exclude='*.pem' \
  --exclude='README.md' --exclude='vercel.json' --exclude='.vercelignore' \
  "$ROOT/" "ubuntu@$IP:/var/www/signal/"

scp -q -i "$KEY" "$ROOT/tools/fetch-helper.mjs" "$ROOT/deploy/lightsail/signal-helper.service" \
  "$ROOT/deploy/lightsail/Caddyfile" "ubuntu@$IP:/tmp/"
"${SSH[@]}" 'set -e
sudo install -o signal -m 644 /tmp/fetch-helper.mjs /opt/signal-helper/fetch-helper.mjs
sudo install -m 644 /tmp/signal-helper.service /etc/systemd/system/signal-helper.service
sudo install -m 644 /tmp/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now signal-helper caddy >/dev/null 2>&1
sudo systemctl restart signal-helper
sudo systemctl reload caddy || sudo systemctl restart caddy
systemctl is-active signal-helper caddy'
echo "https://$SITE_HOST/"
