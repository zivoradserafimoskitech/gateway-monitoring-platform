// MQTT topic contracts, derived from the Enertrek manuals:
//
// G30 (gateway data workstation, JSON uplink, MQTT 5.0):
//   Uplink topics: {userPrefix}/{gatewayId}   e.g. matis/gateway/pVariable/17697439880
//   Prefix is configurable on the gateway; stored per-gateway in the DB.
//
// C30 (4G transparent module, raw Modbus RTU passthrough):
//   Uplink (device → platform): d2g/{UID}  or  d2g/{UID}/{subAddr}
//   Downlink (platform → device): g2d/{UID}
//   UID = module IMEI. Payload = raw Modbus RTU frame (binary).
import type { GatewayModel } from "./modbus";

export const C30_DEFAULT_UPLINK_PREFIX = "d2g";
export const C30_DEFAULT_DOWNLINK_PREFIX = "g2d";
export const G30_DEFAULT_TOPIC_PREFIX = "matis/gateway/pVariable";

export function defaultTopicPrefix(model: GatewayModel): string {
  return model === "C30" ? C30_DEFAULT_UPLINK_PREFIX : G30_DEFAULT_TOPIC_PREFIX;
}

export function defaultTransport(model: GatewayModel): "json" | "transparent" {
  return model === "C30" ? "transparent" : "json";
}

// Uplink topic a gateway publishes telemetry on.
export function uplinkTopic(prefix: string, uid: string): string {
  return `${prefix.replace(/\/+$/, "")}/${uid}`;
}

// Downlink topic the platform publishes commands on.
// C30: g2d/{uid}. G30 downlink is vendor-specific; not used in v1.
export function downlinkTopic(uid: string): string {
  return `${C30_DEFAULT_DOWNLINK_PREFIX}/${uid}`;
}

// Wildcard subscriptions the ingestion service listens on.
export function uplinkWildcard(prefix: string): string {
  return `${prefix.replace(/\/+$/, "")}/#`;
}

// Extract the gateway UID from an uplink topic.
// "matis/gateway/pVariable/17697439880" → "17697439880"
// "d2g/867156067806820" → "867156067806820"
// "d2g/867156067806820/123" → "867156067806820" (trailing sub-address)
export function uidFromTopic(topic: string, prefix: string): string | null {
  const p = prefix.replace(/\/+$/, "");
  if (!topic.startsWith(p + "/")) return null;
  const rest = topic.slice(p.length + 1);
  const first = rest.split("/")[0];
  return first || null;
}
