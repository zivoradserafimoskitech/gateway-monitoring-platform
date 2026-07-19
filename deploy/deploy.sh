#!/usr/bin/env bash
# One-shot deployment of the Enertrek/Kimi gateway platform on a fresh
# Ubuntu 24.04 server. Run as root:  bash deploy.sh
# Idempotent-ish: safe to re-run; docker compose reconciles.
set -euo pipefail

REPO="https://github.com/zivoradserafimoskitech/gateway-monitoring-platform.git"
DIR=/opt/enertrek
INFO=/root/DEPLOY_INFO.txt

log(){ echo "[deploy] $*"; }

# ── 1. Docker ────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# ── 2. Code ──────────────────────────────────────────────────────
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"

# ── 3. Secrets (generated once, kept on re-run) ─────────────────
if [ ! -f .env.deploy ]; then
  log "Generating passwords"
  gen(){ tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24; }
  cat > .env.deploy <<EOF
TIMESCALE_PASSWORD=$(gen)
MYSQL_ROOT_PASSWORD=$(gen)
MYSQL_PASSWORD=$(gen)
EMQX_ADMIN=admin
EMQX_ADMIN_PASSWORD=$(gen)
VOLTFLOW_RO_PASSWORD=$(gen)
EOF
fi
set -a; . ./.env.deploy; set +a
export DATABASE_URL="mysql://enertrek:${MYSQL_PASSWORD}@mysql:3306/enertrek"

# ── 4. Stack up ─────────────────────────────────────────────────
log "Starting stack"
docker compose -f docker-compose.prod.yml --env-file .env.deploy up -d --build

# ── 5. Wait for databases ───────────────────────────────────────
log "Waiting for TimescaleDB"
for i in $(seq 1 60); do
  docker exec "$(docker compose -f docker-compose.prod.yml ps -q timescale)" \
    pg_isready -U postgres -d telemetry >/dev/null 2>&1 && break; sleep 2; done
log "Waiting for MySQL"
for i in $(seq 1 90); do
  docker exec "$(docker compose -f docker-compose.prod.yml ps -q mysql)" \
    mysqladmin ping -uenertrek -p"${MYSQL_PASSWORD}" --silent >/dev/null 2>&1 && break; sleep 2; done

# ── 6. MySQL schema (drizzle) ───────────────────────────────────
log "Applying MySQL schema"
docker compose -f docker-compose.prod.yml --env-file .env.deploy run --rm \
  -e DATABASE_URL="$DATABASE_URL" app npx drizzle-kit push --force || \
  log "WARN: drizzle push failed — run manually later"

# ── 7. VoltFlow read-only role on Timescale ─────────────────────
log "Creating voltflow_ro role"
sed "s/CHANGE_ME_STRONG_PASSWORD/${VOLTFLOW_RO_PASSWORD}/" db/timescale/002_voltflow_readonly.sql | \
  docker exec -i "$(docker compose -f docker-compose.prod.yml ps -q timescale)" \
  psql -U postgres -d telemetry

# ── 8. Firewall ─────────────────────────────────────────────────
log "Configuring firewall"
apt-get install -y -qq ufw >/dev/null 2>&1 || true
ufw allow 22/tcp; ufw allow 1883/tcp; ufw allow 8883/tcp
ufw allow 3000/tcp; ufw allow 5433/tcp
# EMQX dashboard 18083 stays closed — reach it via: ssh -L 18083:localhost:18083 root@server
ufw --force enable

# ── 9. Summary ──────────────────────────────────────────────────
IP=$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
cat > "$INFO" <<EOF
════ Enertrek platform deployed ════
Web UI / API:      http://${IP}:3000
MQTT (gateways):   ${IP}:1883  (TLS: 8883)
EMQX dashboard:    ssh -L 18083:localhost:18083 root@${IP}  → http://localhost:18083
                   user: ${EMQX_ADMIN}  pass: ${EMQX_ADMIN_PASSWORD}
TimescaleDB:       ${IP}:5433  db=telemetry
  superuser:       postgres / ${TIMESCALE_PASSWORD}
  VoltFlow (RO):   voltflow_ro / ${VOLTFLOW_RO_PASSWORD}

Supabase secret for VoltFlow:
TIMESCALE_URL=postgres://voltflow_ro:${VOLTFLOW_RO_PASSWORD}@${IP}:5433/telemetry

All passwords also in: ${DIR}/.env.deploy
Update platform:   cd ${DIR} && git pull && docker compose -f docker-compose.prod.yml --env-file .env.deploy up -d --build
EOF
log "Done. Credentials in ${INFO}"
cat "$INFO"
