#!/usr/bin/env bash
# Nightly Postgres backup for Signal.
#
# Dumps the database from the running postgres container, gzips it, keeps the newest
# BACKUP_KEEP local copies, and uploads to S3 when BACKUP_S3_BUCKET is set.
# Never prints secrets: credentials stay inside the container's own environment.
#
# Usage (on the server):   web/backend/deploy/backup.sh
#
# Sample crontab (crontab -e as the deploy user, who must be in the docker group), 03:15 server time:
#   15 3 * * * /home/ubuntu/student-signal/web/backend/deploy/backup.sh >> /var/log/signal-backup.log 2>&1

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Read one non-secret key from .env without sourcing the whole file.
env_get() {
  local key="$1" default="${2:-}" value=""
  if [[ -f "$ENV_FILE" ]]; then
    value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  fi
  printf '%s' "${value:-$default}"
}

[[ -f "$ENV_FILE" ]] || { log "missing $ENV_FILE"; exit 1; }

BACKUP_DIR="$(env_get BACKUP_DIR /var/backups/signal)"
BACKUP_KEEP="$(env_get BACKUP_KEEP 7)"
BACKUP_S3_BUCKET="$(env_get BACKUP_S3_BUCKET)"
BACKUP_S3_REGION="$(env_get BACKUP_S3_REGION us-east-1)"
BACKUP_S3_PREFIX="$(env_get BACKUP_S3_PREFIX signal/postgres)"

[[ "$BACKUP_KEEP" =~ ^[0-9]+$ ]] && (( BACKUP_KEEP >= 1 )) || { log "BACKUP_KEEP must be a positive integer"; exit 1; }

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/signal-$stamp.sql.gz"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

log "dumping database"
# pg_dump runs inside the container and reads POSTGRES_USER/POSTGRES_DB from its env there.
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  sh -c 'pg_dump --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip -9 > "$partial"

# Refuse to keep an empty or corrupt dump.
gzip -t "$partial"
if [[ "$(gzip -dc "$partial" | wc -c)" -eq 0 ]]; then
  log "dump is empty, aborting"
  exit 1
fi
mv "$partial" "$final"
log "wrote $final ($(du -h "$final" | cut -f1))"

if [[ -n "$BACKUP_S3_BUCKET" ]]; then
  if command -v aws >/dev/null 2>&1; then
    log "uploading to s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/"
    aws s3 cp --only-show-errors --region "$BACKUP_S3_REGION" \
      "$final" "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/$(basename "$final")"
  else
    log "BACKUP_S3_BUCKET is set but the aws CLI is not installed; skipping upload"
    exit 1
  fi
else
  log "BACKUP_S3_BUCKET empty; local copy only"
fi

# Keep the newest BACKUP_KEEP local dumps.
mapfile -t old < <(ls -1t "$BACKUP_DIR"/signal-*.sql.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))")
if (( ${#old[@]} > 0 )); then
  rm -f -- "${old[@]}"
  log "pruned ${#old[@]} old dump(s)"
fi

log "done"
