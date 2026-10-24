# Signed OTA firmware & fleet management — Gateway Monitoring Platform

## Signed firmware
A release may carry an **Ed25519 signature** over the manifest

```
gmp-fw-v1\n<model>\n<version>\n<sha256 lowercase hex>
```

so a signature binds the exact image (sha256) to one model and version.

| Env | Meaning |
| --- | --- |
| `OTA_SIGNING_PUBLIC_KEYS` | `keyId:base64,…` — raw 32-byte Ed25519 key or SPKI DER, base64. **Placeholder — owner must generate the key pair.** |
| `OTA_REQUIRE_SIGNED` | `true` → unsigned releases are refused, rollouts of unsigned releases are refused and ad-hoc firmware jobs (`ota.create type=firmware`) are refused. Default off for backwards compatibility. |

- The platform only holds **public** keys. Sign in the build pipeline: `OTA_SIGNING_PRIVATE_KEY_PEM=… npx tsx scripts/sign-firmware.ts <model> <version> <image>`.
- A provided signature is always verified on `ota.createRelease`, even when not required.
- The OTA frame forwards `sha256`, `signature`, `signingKeyId`. **The gateway firmware must verify** with its built-in public keys before flashing (firmware work, needs hardware verification).

## Fleet
- **Tags** on gateways (`fleet.setTags`, lowercase `[a-z0-9_.:-]`, ≤ 32).
- **Groups** (`fleet.groups/createGroup/deleteGroup/setMembers`), org-scoped; members must be in the group's org.
- **Selectors** (`groupId`, `tags`, `gatewayIds`) are AND-combined and always intersected with what the caller can see. `fleet.resolve` previews.
- **Rollouts** (`ota.createRollout`) accept `groupId` / `tags`.
- **Bulk config** `fleet.bulkConfig` queues one config OTA job per gateway; the caller must pass `confirmCount` equal to the match count (otherwise `CONFLICT`).

UI: OTA page → "Fleet groups and bulk config"; release form has signature + key id.
Migration `0046_signed_ota_fleet.sql`.
