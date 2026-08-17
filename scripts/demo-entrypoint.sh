#!/bin/bash
# Wave 7: demo/preview entrypoint for the all-in-one image.
#
#   external DATABASE_URL → production mode: `exec npm start` and NOTHING else
#                           (byte-identical behavior to the old slim image).
#   no DATABASE_URL       → DEMO MODE: embedded MariaDB + MQTT broker +
#                           device simulators + demo seed, then `exec npm start`.
#
# Every demo-mode step is idempotent so container restarts reuse the existing
# data dir / database / seeded rows.
set -euo pipefail

log() { echo "[demo-entrypoint] $*"; }

# ── production branch ────────────────────────────────────────────────────────
if [ -n "${DATABASE_URL:-}" ]; then
  log "external DATABASE_URL set — production mode (no embedded DB/seeds/sims)"
  exec npm start
fi

# ── demo branch ──────────────────────────────────────────────────────────────
log "=================================================================="
log "DEMO MODE — embedded database, demo credentials"
log "  web login: admin@enertrek.local / admin1234"
log "=================================================================="

cd /app
mkdir -p /app/logs

export DATABASE_URL="mysql://volttrade:volttrade@127.0.0.1:3306/volttrade"
export APP_ID="${APP_ID:-demo-preview}"
export APP_SECRET="${APP_SECRET:-demo-preview-secret}"
export EMAIL_TRANSPORT="${EMAIL_TRANSPORT:-log}"
export EMS_TICK_S="${EMS_TICK_S:-15}"
export TZ="${TZ:-UTC}"

DATADIR=/var/lib/mysql

# 1) MariaDB: initialize the data dir only when empty (idempotent on restart).
if [ ! -d "$DATADIR/mysql" ]; then
  log "initializing MariaDB data dir $DATADIR"
  mariadb-install-db --user=mysql --datadir="$DATADIR" --skip-test-db >/dev/null
else
  log "existing MariaDB data dir — skipping init"
fi

mkdir -p /run/mysqld
chown mysql:mysql /run/mysqld "$DATADIR"

log "starting MariaDB (127.0.0.1:3306)"
mariadbd-safe --user=mysql --datadir="$DATADIR" \
  --bind-address=127.0.0.1 --port=3306 >>/app/logs/mariadb.log 2>&1 &

ready=0
for _ in $(seq 1 60); do
  if mysqladmin ping >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  log "FATAL: MariaDB did not answer mysqladmin ping within 60s (see /app/logs/mariadb.log)"
  exit 1
fi
log "MariaDB is up"

# 2) Database + app user (idempotent). TCP connections from 127.0.0.1 can
#    match either 'localhost' or '127.0.0.1' depending on name resolution —
#    create both.
mysql <<'SQL'
CREATE DATABASE IF NOT EXISTS volttrade;
CREATE USER IF NOT EXISTS 'volttrade'@'localhost' IDENTIFIED BY 'volttrade';
CREATE USER IF NOT EXISTS 'volttrade'@'127.0.0.1' IDENTIFIED BY 'volttrade';
GRANT ALL PRIVILEGES ON volttrade.* TO 'volttrade'@'localhost';
GRANT ALL PRIVILEGES ON volttrade.* TO 'volttrade'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

# 3) Schema: apply the build-time snapshot (db/demo-schema/*.sql — full CREATE
#    TABLE set from db/schema.ts) only when the database is empty. The drizzle
#    "--> statement-breakpoint" marker lines are stripped; every statement
#    already ends with ';'.
table_count=$(mysql -N -B -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='volttrade'")
if [ "$table_count" = "0" ]; then
  log "empty database — applying schema snapshot db/demo-schema/*.sql"
  for f in db/demo-schema/*.sql; do
    log "  applying $f"
    sed '/--> statement-breakpoint/d' "$f" | mysql volttrade
  done
else
  log "database already has $table_count tables — skipping schema apply"
fi

# 4) Demo seed chain (all scripts verified idempotent):
#    admin user → device profile library → SunSpec pack → PV plant (:5021) →
#    ESMU fleet (:5022) → ESMU control whitelist (bench_verified, like dev).
log "seeding demo data"
npx tsx scripts/seed-admin.ts
npx tsx scripts/seed-profiles.ts
npx tsx scripts/seed-sunspec.ts
npx tsx scripts/provision-pv-demo.ts
npx tsx scripts/provision-esmu-demo.ts
npx tsx scripts/seed-esmu-control.ts

# 5) Demo infrastructure processes — EXACT flags from scripts/watchdog.sh.
log "starting MQTT broker + device simulators"
npx tsx scripts/broker.ts >>/app/logs/broker.log 2>&1 &
npx tsx scripts/device-simulator.ts --port 5021 --inverters 6 --bess 2 >>/app/logs/sim5021.log 2>&1 &
npx tsx scripts/device-simulator.ts --esmu --port 5022 --strings 2 >>/app/logs/sim5022.log 2>&1 &
npx tsx scripts/simulator.ts >>/app/logs/sim.log 2>&1 &

# Give the broker a moment so /readyz flips ready quickly (the app retries
# anyway — this only shortens the initial not-ready window).
for _ in $(seq 1 30); do
  if (echo > /dev/tcp/127.0.0.1/1883) 2>/dev/null; then break; fi
  sleep 1
done

log "starting app on 0.0.0.0:3000"
exec npm start
