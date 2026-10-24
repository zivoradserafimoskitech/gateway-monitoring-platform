# Alarm conditions and notification channels

## Conditions (`alarm_rules.operator`)

| Operator | Breach when | `threshold` |
|---|---|---|
| `gt` / `lt` | value above / below threshold | metric unit |
| `stuck` | value unchanged for N seconds (§9.7) | seconds |
| `roc` | \|Δvalue\| per minute above threshold (previous sample of the same rule+device) | units per minute |
| `composite` | AND / OR of 2–8 `gt`/`lt` terms over metrics of the same device | ignored |

`deadband` (optional, all except `stuck`): once raised, a `gt` term clears only
at `value <= threshold - deadband`, an `lt` term at `value >= threshold + deadband`.
`durationSec` still applies on top.

Composite example (`conditions` JSON):

```json
{ "op": "and", "terms": [
  { "metric": "socPercent", "operator": "lt", "threshold": 10 },
  { "metric": "activePowerKw", "operator": "gt", "threshold": 50 } ] }
```

A composite whose result depends on a metric missing from the current sample
is not evaluated for that sample (no raise, no clear). `roc` has no rate on the
first sample after a restart and keeps its state.

## Channels (`notification_channels.type`)

| Type | Target | Config (env) |
|---|---|---|
| `sms` | E.164 number, e.g. `+38970123456` | `SMS_PROVIDER=twilio` + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (number or `MG…` Messaging Service); `SMS_PROVIDER=log` for dev |
| `teams` | Teams Incoming Webhook (`*.webhook.office.com`) or Workflows URL | — (Adaptive Card) |
| `webpush` | PushSubscription JSON from the browser | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (base64url raw P-256), `VAPID_SUBJECT` |

Web push is **payload-less**: the push only wakes the service worker, which
fetches the alarms itself — no alarm text is stored at the push service and no
RFC 8291 payload encryption is needed. Generate VAPID keys once, e.g.
`npx web-push generate-vapid-keys`, and keep the private key in the secret store.

Credentials are never stored on the channel row. Without them the channel's
deliveries fail with an explicit error in the delivery history.

Migration: `db/migrations/0043_alarm_conditions_channels.sql` (additive).
