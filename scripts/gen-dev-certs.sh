#!/usr/bin/env bash
# v7/C3: generate self-signed development certificates for mqtts:// (and for
# HTTPS reverse-proxy testing). For PRODUCTION use real certificates (e.g.
# Let's Encrypt via Caddy — see docs/tls.md); self-signed certs require every
# gateway to trust the CA explicitly.
#
#   scripts/gen-dev-certs.sh [output-dir] [hostname]
set -euo pipefail
DIR="${1:-certs}"
HOST="${2:-localhost}"
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$DIR/dev.key" -out "$DIR/dev.crt" -days 825 \
  -subj "/CN=${HOST}" \
  -addext "subjectAltName=DNS:localhost,DNS:${HOST},IP:127.0.0.1"
chmod 600 "$DIR/dev.key"
echo "wrote $DIR/dev.key and $DIR/dev.crt (CN=${HOST}, self-signed, 825 days)"
