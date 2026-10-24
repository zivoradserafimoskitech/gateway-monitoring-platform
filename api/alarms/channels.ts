// Extra alarm notification channels: SMS, Web Push, Microsoft Teams.
//
// SMS goes through a provider abstraction so the vendor is a config choice.
// "twilio" is implemented against Twilio's REST API (Messages resource);
// "log" records instead of sending (dev/test). Credentials are env-only and
// never stored on the channel row — the row holds just the phone number.
//
//   SMS_PROVIDER=twilio|log
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (E.164 or Messaging Service SID "MG...")
//
// Web Push uses VAPID (RFC 8292) and sends a payload-less push: the service
// worker wakes and fetches the latest alarms itself. That avoids RFC 8291
// payload encryption entirely and means no alarm text sits in a push
// service's queue.
//
//   VAPID_PUBLIC_KEY  (base64url, 65-byte uncompressed P-256 point)
//   VAPID_PRIVATE_KEY (base64url, 32-byte scalar)
//   VAPID_SUBJECT     (mailto: or https: contact)
//
// Teams uses an Incoming Webhook / Workflows URL and posts an Adaptive Card.
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

const TIMEOUT_MS = 10_000;

// ─── SMS ─────────────────────────────────────────────────────────────────────

export const E164 = /^\+[1-9]\d{6,14}$/;

export interface SmsProvider {
  readonly name: string;
  send(to: string, text: string): Promise<void>;
}

export class TwilioSms implements SmsProvider {
  readonly name = "twilio";
  private readonly sid: string;
  private readonly token: string;
  private readonly from: string;
  private readonly fetchFn: typeof fetch;
  constructor(sid: string, token: string, from: string, fetchFn: typeof fetch = fetch) {
    this.sid = sid;
    this.token = token;
    this.from = from;
    this.fetchFn = fetchFn;
  }
  async send(to: string, text: string): Promise<void> {
    const body = new URLSearchParams({ To: to, Body: text.slice(0, 1500) });
    if (this.from.startsWith("MG")) body.set("MessagingServiceSid", this.from);
    else body.set("From", this.from);
    const res = await this.fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.sid)}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`SMS provider HTTP ${res.status}`);
  }
}

export class LogSms implements SmsProvider {
  readonly name = "log";
  readonly sent: Array<{ to: string; text: string }> = [];
  async send(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
    console.log(`[sms:log] to=${to} ${text}`);
  }
}

export function smsProviderFromEnv(env: NodeJS.ProcessEnv = process.env): SmsProvider {
  const p = (env.SMS_PROVIDER ?? "").toLowerCase();
  if (p === "log") return new LogSms();
  if (p === "twilio") {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
    if (!sid || !token || !from) throw new Error("SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM");
    return new TwilioSms(sid, token, from);
  }
  throw new Error("no SMS provider configured (set SMS_PROVIDER=twilio or SMS_PROVIDER=log)");
}

export function smsText(payload: Record<string, unknown>): string {
  const prefix = payload.kind === "escalation" ? "ESCALATION " : payload.kind === "resolved" ? "RESOLVED " : "";
  return `[Gateway] ${prefix}${String(payload.severity ?? "").toUpperCase()} ${payload.message}`.slice(0, 320);
}

// ─── Microsoft Teams ─────────────────────────────────────────────────────────

export function teamsCard(payload: Record<string, unknown>): Record<string, unknown> {
  const color = payload.kind === "resolved" ? "Good" : payload.severity === "critical" ? "Attention" : "Warning";
  const title = `${payload.kind === "resolved" ? "RESOLVED" : payload.kind === "escalation" ? "ESCALATION" : "Alarm"}: ${payload.message}`;
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", color, wrap: true },
            {
              type: "FactSet",
              facts: [
                { title: "Device", value: String(payload.meterName ?? payload.meterId ?? "-") },
                { title: "Value", value: String(payload.value ?? "-") },
                { title: "Threshold", value: String(payload.threshold ?? "-") },
                { title: "Severity", value: String(payload.severity ?? "-") },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** Teams webhook hosts we accept (Incoming Webhook + Power Automate Workflows). */
export function isTeamsWebhookUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (
      url.protocol === "https:" &&
      (/\.webhook\.office\.com$/.test(url.hostname) || /\.logic\.azure\.com$/.test(url.hostname) || /\.environment\.api\.powerplatform\.com$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}

// ─── Web Push (VAPID, payload-less) ──────────────────────────────────────────

export interface PushSubscriptionJson {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
}

export function parsePushSubscription(target: string): PushSubscriptionJson | null {
  try {
    const s = JSON.parse(target) as PushSubscriptionJson;
    if (typeof s?.endpoint !== "string") return null;
    const u = new URL(s.endpoint);
    return u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

const b64u = (b: Buffer) => b.toString("base64url");

/** VAPID JWT (ES256) for one push service origin. */
export function vapidJwt(audience: string, subject: string, publicKeyB64u: string, privateKeyB64u: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const pub = Buffer.from(publicKeyB64u, "base64url");
  const d = Buffer.from(privateKeyB64u, "base64url");
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error("VAPID keys must be a 65-byte uncompressed P-256 public key and a 32-byte private key (base64url)");
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })));
  const sig = cryptoSign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64u(sig)}`;
}

export async function sendWebPush(sub: PushSubscriptionJson, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<void> {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subject } = env;
  if (!pub || !priv || !subject) throw new Error("web push needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT");
  const aud = new URL(sub.endpoint).origin;
  const res = await fetchFn(sub.endpoint, {
    method: "POST",
    headers: { authorization: `vapid t=${vapidJwt(aud, subject, pub, priv)}, k=${pub}`, ttl: "3600", urgency: "high", "content-length": "0" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 404/410 = subscription gone; surfaced as a failure so the delivery log shows it.
  if (!res.ok) throw new Error(`push service HTTP ${res.status}${res.status === 404 || res.status === 410 ? " (subscription expired — remove the channel)" : ""}`);
}
