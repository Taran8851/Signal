#!/usr/bin/env bash
# Install or update self-hosted Firecrawl on the Lightsail box.
#   web/backend/deploy/firecrawl/deploy.sh          (then web/backend/deploy/lightsail/deploy.sh for the Caddy route)
# Env: SIGNAL_HOST (default 100.59.200.218, the 8 GB EC2 instance), SIGNAL_KEY (default ~/.ssh/id_ed25519)
# Secrets are made on the box and never leave it, except Signal's key, printed once at the end
# (-k) so it can be pasted into Signal: Settings → Search & reading → Firecrawl (your server).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
IP="${SIGNAL_HOST:-100.59.200.218}"
KEY="${SIGNAL_KEY:-$HOME/.ssh/id_ed25519}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=15 "ubuntu@$IP")

"${SSH[@]}" 'set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then
  sudo apt-get update -q
  sudo apt-get install -yq docker.io docker-compose-v2
  sudo systemctl enable --now docker
fi
# 2 GB of RAM is not enough for a browser plus the queue; 4 GB of swap keeps it from being killed.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q "^/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
  echo "vm.swappiness=20" | sudo tee /etc/sysctl.d/90-swap.conf >/dev/null && sudo sysctl -q -p /etc/sysctl.d/90-swap.conf
fi
sudo mkdir -p /opt/firecrawl/searxng && sudo chown -R ubuntu: /opt/firecrawl'

scp -q -i "$KEY" "$ROOT/web/backend/deploy/firecrawl/docker-compose.yml" "ubuntu@$IP:/opt/firecrawl/docker-compose.yml"
scp -q -i "$KEY" "$ROOT/web/backend/deploy/firecrawl/searxng/settings.yml" "ubuntu@$IP:/opt/firecrawl/searxng/settings.yml"

"${SSH[@]}" 'set -euo pipefail
cd /opt/firecrawl
if [[ ! -f .env ]]; then
  umask 077
  printf "POSTGRES_PASSWORD=%s\nSEARXNG_SECRET=%s\n" "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > .env
fi
# Signal'"'"'s key for the Caddy route. Made once; kept in Caddy'"'"'s environment file.
if ! sudo grep -q "^FIRECRAWL_SIGNAL_KEY=." /etc/default/caddy; then
  echo "FIRECRAWL_SIGNAL_KEY=fc-self-$(openssl rand -hex 24)" | sudo tee -a /etc/default/caddy >/dev/null
fi
sudo docker compose pull -q
sudo docker compose up -d --remove-orphans
sudo docker compose ps --format "table {{.Service}}\t{{.State}}\t{{.Status}}"'

if [[ "${1:-}" == "-k" ]]; then
  "${SSH[@]}" 'sudo grep "^FIRECRAWL_SIGNAL_KEY=" /etc/default/caddy | cut -d= -f2-'
fi
