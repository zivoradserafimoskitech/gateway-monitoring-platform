#!/bin/bash
# watchdog.sh — држи ја demo инфраструктурата жива (sandbox ги убива демоните
# при idle cleanup / FUSE рестарти). Проверка на 30s; рестартира само она што
# недостасува. Секој циклус е hard-capped со timeout 25 — ако која било
# проверка се zaklini (FUSE-stale mount), следниот циклус сепак работи.
# Heartbeat ред на секој циклус: тишина во watchdog.log = wedged watchdog.
APP=/mnt/agents/output/app
LOGS=/mnt/agents/output/logs
mkdir -p "$LOGS"

port_open() { timeout 3 bash -c "(echo > /dev/tcp/127.0.0.1/$1) 2>/dev/null"; }
proc_alive() { for c in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$c" 2>/dev/null | grep -q "$1" && return 0; done; return 1; }
start_daemon() { # name, logfile, cmd...
  local name="$1" log="$2"; shift 2
  echo "$(date -u +%FT%TZ) watchdog: starting $name" >> "$LOGS/watchdog.log"
  setsid nohup bash -c "cd $APP && exec $*" >> "$LOGS/$log" 2>&1 &
}

cycle() {
  port_open 1883 || start_daemon broker broker.log "npx tsx scripts/broker.ts"
  port_open 5021 || start_daemon pv-sim sim5021.log "npx tsx scripts/device-simulator.ts --port 5021 --inverters 6 --bess 2"
  port_open 5022 || start_daemon esmu-sim sim5022.log "npx tsx scripts/device-simulator.ts --esmu --port 5022 --strings 2"
  proc_alive "scripts/simulator.ts" || start_daemon mqtt-sim sim.log "npx tsx scripts/simulator.ts"
  port_open 3000 || start_daemon dev-server dev.log "env EMS_TICK_S=5 EMAIL_TRANSPORT=log npx vite --host 0.0.0.0 --port 3000"
}

if [ "$1" = "--once" ]; then cycle; exit 0; fi

while true; do
  timeout 25 bash "$0" --once
  echo "$(date -u +%FT%TZ) watchdog: heartbeat" >> "$LOGS/watchdog.log"
  sleep 30
done
