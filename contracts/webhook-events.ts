// §9.15: the event catalogue for outbound webhooks.
//
// In contracts/ because both sides pick from it: the server refuses a
// subscription to an event it does not emit, and the settings screen offers
// exactly the same list. A UI checkbox for an event nothing publishes is an
// integration that silently never fires.
//
// Every name here is emitted by real code. Adding one to this list without an
// emitter is worse than leaving it out — an integrator who subscribes to it
// will conclude the condition never happened.
export const WEBHOOK_EVENTS = [
  // An alarm was raised and is live. Covers every rule kind, including the
  // gateway-offline and frozen-register detectors.
  "alarm.raised",
  // An alarm was raised but no one was paged, because a suppression was in
  // force. Published deliberately: an integration that mirrors alarm state
  // must not conclude the condition did not occur just because a human
  // decided not to be woken for it.
  "alarm.suppressed",
  // The condition went away on its own and the alarm closed.
  "alarm.resolved",
  // A setpoint was written to plant, with its outcome. This is the event an
  // auditor asks for: who changed what on the equipment, and did it take.
  "command.executed",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(v: string): v is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(v);
}

/** Header carrying the signature, and the one carrying the delivery id. */
export const SIGNATURE_HEADER = "x-volttrade-signature";
export const DELIVERY_HEADER = "x-volttrade-delivery";
export const EVENT_HEADER = "x-volttrade-event";

/**
 * How far a delivery's timestamp may be from the receiver's clock before it
 * should be rejected as a replay. Five minutes is the usual figure and is
 * generous enough for a queued retry that waited on a slow network, while
 * still bounding how long a captured request stays useful to an attacker.
 *
 * Published here so the documented value and the value our own verifier uses
 * cannot drift apart.
 */
export const SIGNATURE_TOLERANCE_SEC = 300;
