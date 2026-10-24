# Remote diagnostics — Gateway Monitoring Platform

Troubleshoot a gateway without site access, over the existing MQTT connection.

| Direction | Topic | Payload |
| --- | --- | --- |
| platform → gateway | `g2d/<uid>/diag` | `{"id":"<uuid>","cmd":"logs","args":{"lines":200,"level":"info"}}` |
| gateway → platform | `d2g/<uid>/diag` | `{"id":"<uuid>","ok":true,"lines":["…"]}` or `{"id","ok":false,"error":"…"}` |

## Commands (allow-list, enforced server-side)
| cmd | args | role |
| --- | --- | --- |
| `logs` | `lines` 1–5000, `level` debug/info/warn/error | operator |
| `sysinfo` | – (uptime, firmware, CPU/mem/disk) | operator |
| `netinfo` | – (interfaces, signal, routes) | operator |
| `ping` | `host` (hostname/IPv4 only), `count` 1–20 | operator |
| `modbus-scan` | `from`,`to` unit ids 1–247 | operator |
| `restart-agent` | – | admin (logged) |

Responses are correlated by `id` and must come from the same gateway. Requests time
out after `DIAG_TIMEOUT_MS` (default 30 s), output is capped at 256 KiB, and results are
kept in memory for 1 h (not persisted, lost on restart).

**Firmware requirement:** the gateway firmware must implement this topic/command set —
needs confirmation from the firmware side / hardware test.

API: tRPC `diagnostics.remoteRun`, `remoteResult`, `remoteHistory`. UI: "Remote diagnostics" card on the gateway page.
