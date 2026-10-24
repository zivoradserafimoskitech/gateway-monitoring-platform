import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isTeamsWebhookUrl, LogSms, parsePushSubscription, sendWebPush, smsProviderFromEnv, smsText, teamsCard, TwilioSms, vapidJwt, E164 } from "./channels";

function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string; y: string };
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return { pub, priv: jwk.d, publicKey };
}

describe("SMS", () => {
  it("selects providers from env and refuses half-configured twilio", () => {
    expect(smsProviderFromEnv({ SMS_PROVIDER: "log" }).name).toBe("log");
    expect(() => smsProviderFromEnv({ SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1" })).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(() => smsProviderFromEnv({})).toThrow(/no SMS provider/);
  });
  it("posts the Twilio Messages form with basic auth", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    await new TwilioSms("AC123", "tok", "+38970000000", fake).send("+38971111111", "hello");
    expect(seen!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(String(seen!.init.body)).toContain("To=%2B38971111111");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("AC123:tok").toString("base64")}`);
  });
  it("formats text and validates E.164", () => {
    expect(smsText({ kind: "resolved", severity: "critical", message: "x" })).toBe("[Gateway] RESOLVED CRITICAL x");
    expect(E164.test("+38970123456")).toBe(true);
    expect(E164.test("070123456")).toBe(false);
    const log = new LogSms();
    void log.send("+1", "t");
    expect(log.sent).toHaveLength(1);
  });
});

describe("Teams", () => {
  it("builds an adaptive card and accepts only Teams/Workflows hosts", () => {
    const c = teamsCard({ kind: "initial", severity: "critical", message: "Overtemp", meterName: "BESS 1" }) as { attachments: Array<{ content: { body: Array<{ text?: string; color?: string }> } }> };
    expect(c.attachments[0].content.body[0]).toMatchObject({ text: "Alarm: Overtemp", color: "Attention" });
    expect(isTeamsWebhookUrl("https://contoso.webhook.office.com/webhookb2/abc")).toBe(true);
    expect(isTeamsWebhookUrl("https://prod-12.westeurope.logic.azure.com/workflows/x")).toBe(true);
    expect(isTeamsWebhookUrl("https://evil.example.com/x")).toBe(false);
    expect(isTeamsWebhookUrl("http://contoso.webhook.office.com/x")).toBe(false);
  });
});

describe("Web push", () => {
  it("parses subscriptions", () => {
    expect(parsePushSubscription('{"endpoint":"https://fcm.googleapis.com/fcm/send/x"}')).not.toBeNull();
    expect(parsePushSubscription('{"endpoint":"http://x"}')).toBeNull();
    expect(parsePushSubscription("nope")).toBeNull();
  });
  it("signs a verifiable ES256 VAPID JWT", () => {
    const k = vapidKeys();
    const jwt = vapidJwt("https://fcm.googleapis.com", "mailto:ops@example.com", k.pub, k.priv, 1000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: 1000 + 43200, sub: "mailto:ops@example.com" });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: k.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
  });
  it("sends a payload-less push with VAPID auth", async () => {
    const k = vapidKeys();
    let headers: Record<string, string> = {};
    const fake = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    await sendWebPush({ endpoint: "https://push.example.com/abc" }, { VAPID_PUBLIC_KEY: k.pub, VAPID_PRIVATE_KEY: k.priv, VAPID_SUBJECT: "mailto:a@b.c" }, fake);
    expect(headers.authorization).toMatch(/^vapid t=.+, k=/);
    await expect(sendWebPush({ endpoint: "https://push.example.com/abc" }, {})).rejects.toThrow(/VAPID/);
  });
});
