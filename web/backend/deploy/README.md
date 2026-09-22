# Deploying Signal

Runbook for putting the Signal app on one AWS VPS behind the Vercel landing site.
Written before any of it has been run. Every step marked **(unverified)** has not been tested
end to end on this project yet. Fix this file when reality disagrees.

```
browser ──> <project>.vercel.app
              ├─ /, /app/*          static files on Vercel (landing page + current demo console)
              └─ /console/*, /api/*  ──rewrite──> https://SITE_HOST  (Caddy, auto HTTPS)
                                                    ├─ web        SvelteKit adapter-node :3000
                                                    ├─ collector  polling loop + Discord bot
                                                    └─ postgres   internal network only
```

## Naming change: `/console`, not `/app`

`docs/platform_plan.md` §6 and §9 say Vercel rewrites `/app/*` to the VPS. The static demo
console already lives at `/app/` on the landing site and must keep working, so the rewrite uses
**`/console/*`** for the real app instead. `/api/*` is unchanged.

Consequences for `web/`:
- Set `kit.paths.base = '/console'` so pages and assets live under `/console`.
- Serve API routes at `/api/*` (outside the base path).
- Serve `GET /api/healthz` → 200 without auth (the compose healthcheck uses it).

When `app/` is deleted (plan §9), you can decide whether to move the app back to `/app`. That
means changing `vercel.json`, the base path, and every OAuth callback URL together.

## Files

| File | What it is |
|---|---|
| `../vercel.json` | Rewrites `/console/*` and `/api/*` to the VPS; security headers for the static site |
| `docker-compose.yml` | `postgres`, `caddy`, and (profile `app`) `web`, `collector` |
| `Caddyfile` | HTTPS, `/healthz` placeholder, reverse proxy to `web:3000` |
| `.env.example` | Every variable, placeholders only. Copy to `.env` on the server |
| `backup.sh` | Nightly `pg_dump` → gzip → optional S3, keeps N local copies |

## 0. Before the first Vercel deploy: what Vercel publishes

Vercel publishes `web/frontend/` only (`outputDirectory` in the root `vercel.json`), and the root
`.vercelignore` keeps `app/`, `web/backend/`, `docs/`, `reference/`, `packages/` and the rule files
from being uploaded at all. `web/backend/deploy/.env` is git-ignored (the root `.gitignore` has
`.env`); never add it to either list's exceptions.

## 1. Create the instance

1. In the AWS console, pick a region close to your users (decide this with the team).
2. Launch an EC2 instance:
   - **Image:** Ubuntu Server 24.04 LTS.
   - **Size:** 2 vCPU / 2 GiB RAM is the target the compose limits assume (for example
     `t3.small`, or `t4g.small` on ARM; the images used are multi-arch). 1 GiB is too tight
     for Postgres + Node + Docker builds. Check current prices yourself.
   - **Disk:** 20–30 GiB gp3.
   - **Key pair:** create or pick one. Keep the `.pem` private.
3. Security group, inbound rules only:
   - `22/tcp` from **your IP only** (`My IP` in the console). Update it when your IP changes.
   - `80/tcp` from `0.0.0.0/0` and `::/0` (Let's Encrypt HTTP challenge and redirect).
   - `443/tcp` from `0.0.0.0/0` and `::/0`.
   - Optional `443/udp` for HTTP/3. Nothing else. **Never open 5432.**
4. Allocate an **Elastic IP** and associate it with the instance, so the IP (and hostname)
   survives reboots.
5. For S3 backups, attach an **IAM instance role** allowing `s3:PutObject` (and `s3:GetObject`
   for restore) on your backup bucket only. This avoids putting AWS keys in `.env`.

## 2. Harden SSH and the OS

```bash
ssh -i path/to/key.pem ubuntu@ELASTIC_IP
```

1. Disable password login (Ubuntu cloud images usually ship with it off; confirm):
   ```bash
   sudo tee /etc/ssh/sshd_config.d/99-signal.conf >/dev/null <<'EOF'
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   PermitRootLogin no
   EOF
   sudo sshd -t && sudo systemctl reload ssh
   ```
   Keep your current session open and test a **new** SSH session before logging out.
2. Turn on automatic security updates:
   ```bash
   sudo apt update && sudo apt -y upgrade
   sudo apt -y install unattended-upgrades
   sudo dpkg-reconfigure -plow unattended-upgrades
   ```
3. Optional: add 1–2 GiB swap if you build images on the box.

## 3. Install Docker

Use Docker's official apt repository (instructions: docs.docker.com → Install Docker Engine on
Ubuntu). It installs `docker-ce` and the `docker compose` plugin. Then:

```bash
sudo usermod -aG docker ubuntu   # log out and back in afterwards
docker compose version
```

Note: Docker publishes ports by writing its own iptables rules, which **bypass `ufw`**. The AWS
security group is the firewall that matters here. That is why Postgres has no `ports:` entry at all.

## 4. Get a hostname (no domain needed)

Caddy needs a hostname to get a certificate.

**Option A: sslip.io (simplest).** Take the Elastic IP with dots replaced by dashes:
`203.0.113.10` → `203-0-113-10.sslip.io`. It resolves to that IP with no signup. Check:
```bash
dig +short 203-0-113-10.sslip.io
```
(unverified for this project) Let's Encrypt issuance for shared wildcard-DNS names usually works,
but can hit rate limits because many people use them. If issuance fails, see Troubleshooting.

**Option B: your own domain.** Add an `A` record, e.g. `api.example.com → ELASTIC_IP`, and use
that as `SITE_HOST`.

**Option C: Cloudflare Tunnel** (unverified, needs a domain on Cloudflare). `cloudflared` makes an
outbound connection, so ports 80/443 do not need to be open at all and Cloudflare terminates TLS.
You would replace the `caddy` service with a `cloudflared` service pointing at `http://web:3000`.
Not scaffolded here; do it only if ports 80/443 turn out to be blocked.

## 5. Put the code and the env file on the server

```bash
git clone <repo-url> ~/student-signal     # or rsync/scp the folder
cd ~/student-signal
cp web/backend/deploy/.env.example web/backend/deploy/.env
chmod 600 web/backend/deploy/.env
nano web/backend/deploy/.env
```

Fill in at least `SITE_HOST`, `PUBLIC_ORIGIN`, and the Postgres values for the smoke test.
Generate secrets on the server, never reuse examples:

```bash
openssl rand -hex 24      # POSTGRES_PASSWORD (also paste into DATABASE_URL)
openssl rand -base64 32   # ENCRYPTION_MASTER_KEY
openssl rand -base64 32   # BETTER_AUTH_SECRET
```

Save `ENCRYPTION_MASTER_KEY` in a password manager. Without it, stored API keys are unrecoverable.

## 6. Smoke test before the app exists

`web/` and `collector/` are behind the compose profile `app`, so a plain `up` starts only
Postgres and Caddy:

```bash
docker compose -f web/backend/deploy/docker-compose.yml up -d
docker compose -f web/backend/deploy/docker-compose.yml ps          # both should become "healthy"
docker compose -f web/backend/deploy/docker-compose.yml logs -f caddy   # watch for "certificate obtained"
```

(Equivalent, explicit: `docker compose -f web/backend/deploy/docker-compose.yml up -d postgres caddy`.)

**Direct to the VPS:**
```bash
curl -i https://SITE_HOST/healthz        # expect 200 and "ok"
curl -i http://SITE_HOST/healthz         # expect a redirect to https
```
Any other path returns 502 until `web` exists. That is expected.

**Through Vercel:**
1. In `vercel.json`, replace both `VPS_HOSTNAME` placeholders with your `SITE_HOST`. (The
   hostname is not a secret, but it is public once committed.)
2. Deploy to Vercel.
3. ```bash
   curl -i https://YOUR-PROJECT.vercel.app/api/healthz   # expect 200 "ok" from Caddy
   curl -I https://YOUR-PROJECT.vercel.app/app/frontend/signal.html  # expect 200, the static console
   ```
   If `/api/healthz` works, the rewrite path is proven. This is plan build step 3.

## 7. Bring up the full stack (once `web/` and `collector/` exist)

Requirements for those directories (not yet written):
- `web/Dockerfile` and `collector/Dockerfile`, built with the **repo root as context** (so they
  can copy `packages/core`).
- `web` listens on `0.0.0.0:3000`, serves `/api/healthz`, and has `wget` in the image
  (Alpine-based Node images do; `-slim` images do not — change the healthcheck if so).
- `collector` touches `/tmp/collector-heartbeat` each tick.
- Remove `/api/healthz` from the Caddy `@health` matcher so the app's own check is what Vercel sees.

Then:
```bash
docker compose -f web/backend/deploy/docker-compose.yml --profile app up -d --build
docker compose -f web/backend/deploy/docker-compose.yml --profile app ps
docker compose -f web/backend/deploy/docker-compose.yml --profile app logs -f web collector
```

Register OAuth callback URLs on the **Vercel** origin (`PUBLIC_ORIGIN`), not on `SITE_HOST`.

Building on a 2 GiB box may run out of memory. If so, build images elsewhere and push to a
registry (e.g. GHCR/ECR), or add swap. (unverified)

## 8. Backups

```bash
chmod +x web/backend/deploy/backup.sh
sudo mkdir -p /var/backups/signal && sudo chown ubuntu: /var/backups/signal
web/backend/deploy/backup.sh                     # run once by hand and check the output
```

For S3: create a private bucket, set `BACKUP_S3_BUCKET` / `BACKUP_S3_REGION` in `.env`, install the
AWS CLI (`sudo snap install aws-cli --classic`), and use the instance role from step 1.5.

Nightly cron (`crontab -e`):
```
15 3 * * * /home/ubuntu/student-signal/web/backend/deploy/backup.sh >> /var/log/signal-backup.log 2>&1
```
Create the log file first: `sudo touch /var/log/signal-backup.log && sudo chown ubuntu: /var/log/signal-backup.log`.

Dumps are kept in `/var/backups/signal`, **outside the repo**, so they never get zipped or committed.

### Restore

**This overwrites the database.** Stop writers first.

```bash
cd ~/student-signal
# Optional: fetch from S3
aws s3 cp s3://BUCKET/signal/postgres/signal-YYYYMMDDTHHMMSSZ.sql.gz /var/backups/signal/

docker compose -f web/backend/deploy/docker-compose.yml --profile app stop web collector
docker compose -f web/backend/deploy/docker-compose.yml exec -T postgres \
  sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
gunzip -c /var/backups/signal/signal-YYYYMMDDTHHMMSSZ.sql.gz \
  | docker compose -f web/backend/deploy/docker-compose.yml exec -T postgres \
      sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose -f web/backend/deploy/docker-compose.yml --profile app start web collector
```
(unverified) Practice a restore once before you need it. A backup you have never restored is a guess.

## 9. Rolling back

**App code:**
```bash
web/backend/deploy/backup.sh                                  # snapshot data first
git log --oneline -5
git checkout <last-good-commit>
docker compose -f web/backend/deploy/docker-compose.yml --profile app up -d --build web collector
```
If the bad release ran a database migration that the old code cannot read, restore the backup
taken before the deploy (section 8). Take one before every deploy for this reason.

**Vercel:** in the Vercel dashboard, promote the previous deployment ("Instant Rollback"). This
restores the old `vercel.json` rewrites too.

**Kill switch:** to take the app offline but keep the landing page up, stop the app services:
`docker compose -f web/backend/deploy/docker-compose.yml --profile app stop web collector`.

## 10. Troubleshooting

**Sign-in loops, cookies missing, or "Cross-site POST form submissions are forbidden."**
Visitors are on the Vercel URL, but the request reaching the app has the VPS hostname in `Host`.
- `PUBLIC_ORIGIN`, `ORIGIN` (set from it in compose) and `BETTER_AUTH_URL` must all be exactly the
  Vercel URL: `https`, no trailing slash, same spelling as the browser address bar.
- OAuth callback URLs must use the Vercel URL.
- Do not set cookie `Domain` to `SITE_HOST`. Leave it unset (host-only), so the browser stores it
  for the Vercel host.
- The app must not build URLs from `Host` / `X-Forwarded-Host`. Caddy does not trust forwarded
  headers (see comments in `Caddyfile`); Vercel's original value is available as
  `X-Vercel-Forwarded-Host` for debugging only.
- (unverified) Whether Vercel forwards `Set-Cookie` and streaming responses through external
  rewrites unchanged must be tested with the real app. Plan §9 calls this out.
- Preview deployments get a different URL, so sign-in only works on the production Vercel URL
  unless you add those origins too.

**Caddy cannot get a certificate.**
- `docker compose -f web/backend/deploy/docker-compose.yml logs caddy` shows the ACME error.
- `dig +short SITE_HOST` must return the Elastic IP.
- Ports 80 and 443 must be open in the security group (both are used for challenges).
- Rate limited on sslip.io: wait and retry later, try `nip.io` the same way, or use your own domain.
  Do not delete the `caddy_data` volume: it holds issued certs and re-issuing burns rate limit.
- Testing repeatedly? Temporarily add `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`
  in the Caddyfile global block, then remove it.

**Port 80 or 443 unreachable.**
- `curl -v http://ELASTIC_IP/` from your laptop. Timeout means the security group or network ACL.
- On the box: `sudo ss -tlnp | grep -E ':80|:443'` should show `docker-proxy`.
- Some campus or office networks block outbound ports. Test from a phone hotspot before blaming AWS.
- If inbound 80/443 is truly not possible, use Cloudflare Tunnel (section 4, option C).

**Vercel returns 404 for `/console` or `/api`.**
- Check `VPS_HOSTNAME` was replaced in `vercel.json` and redeployed.
- A static file at the same path wins over a rewrite on Vercel. Do not add `console/` or `api/`
  folders to the repo root.

**Container keeps restarting.**
- `docker compose -f web/backend/deploy/docker-compose.yml --profile app ps` and `logs <service>`.
- `OOMKilled` in `docker inspect <container>` → raise `mem_limit` or the instance size.
