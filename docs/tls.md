# TLS configuration (v7/C3)

Two surfaces can carry TLS: **gateway → MQTT broker** (mqtts) and **browser → web app** (HTTPS via reverse proxy).

## 1. MQTT over TLS (mqtts://)

The embedded broker (`scripts/broker.ts`) starts a TLS listener **whenever cert files exist**:

| Env var | Default | Meaning |
|---|---|---|
| `MQTT_TLS_KEY` | `certs/dev.key` | private key path |
| `MQTT_TLS_CERT` | `certs/dev.crt` | certificate path |
| `MQTT_TLS_PORT` | `8883` | TLS listener port |
| `MQTT_TLS` | `1` | set `0` to force-disable even when certs exist |

### Development (self-signed)

```bash
scripts/gen-dev-certs.sh certs localhost   # CN=localhost, SAN localhost+127.0.0.1, 825 days
npx tsx scripts/broker.ts                  # now logs "aedes TLS listening on 0.0.0.0:8883 (mqtts)"
```

Self-signed certs are rejected by default MQTT clients — gateways must either
**pin the CA** (upload `dev.crt` as trusted CA, preferred) or disable
verification (`rejectUnauthorized=false`, dev only).

Verified by `scripts/probe-v7-tls.ts`: pinned-CA strict connect works, no-CA
connect is rejected (`self-signed certificate`), pub/sub roundtrip over mqtts,
plaintext 1883 unaffected.

### Production

Use CA-issued certificates (Let's Encrypt or your internal CA) and point
`MQTT_TLS_KEY`/`MQTT_TLS_CERT` at them. Disable the plaintext listener for
untrusted networks by firewalling 1883 (or `MQTT_BIND_HOST=127.0.0.1` if only
the platform itself uses plaintext locally) — the platform's own client
connects to `mqtt://127.0.0.1:1883` internally and does not need TLS on-loopback.

Combine with `MQTT_USERNAME`/`MQTT_PASSWORD` (already enforced by the broker
when set): TLS protects the channel, credentials authenticate the client.

### External broker

If `MQTT_URL` is set (managed broker), TLS is broker-side; use an `mqtts://`
URL and the platform client negotiates TLS automatically.

## 2. HTTPS for the web app (Caddy)

Terminate TLS at a reverse proxy in front of the app (`:3000`). Sample
`Caddyfile`:

```caddyfile
enertrek.example.com {
    reverse_proxy 127.0.0.1:3000
    # automatic Let's Encrypt certificates
    encode zstd gzip
}

# Optional: protect the Prometheus endpoint (it is intentionally unauthenticated)
enertrek.example.com {
    @metrics path /metrics
    basic_auth @metrics {
        metrics <bcrypt-hash>   # caddy hash-password
    }
    reverse_proxy 127.0.0.1:3000
}
```

Nginx/Traefik equivalents work the same way: proxy to `127.0.0.1:3000`, and
restrict `/metrics` if the port is reachable beyond localhost.
