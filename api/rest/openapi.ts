// §9.13: the machine-readable API contract.
//
// Hand-written rather than generated, because nothing in this stack generates
// it: the REST surface is Hono handlers, not a schema-first framework, and
// adding a generator would mean adding a dependency that has to be right about
// hand-rolled validation it cannot see.
//
// The risk with a hand-written spec is drift — it describes last quarter's API
// and an integrator generates a client against a route that no longer exists.
// That is why tests/openapi-routes.test.ts walks the routes Hono has actually
// registered and fails when one is missing from here or described here without
// existing. The test is the thing that makes this file trustworthy; without it
// this is documentation, not a contract.
import { WEBHOOK_EVENTS } from "@contracts/webhook-events";

const deviceIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "integer", format: "int64" },
  description: "Device (meter) id. Must belong to the API key's organization.",
} as const;

const isoRange = [
  {
    name: "from",
    in: "query",
    required: true,
    schema: { type: "string", format: "date-time" },
    description: "Inclusive start, ISO8601.",
  },
  {
    name: "to",
    in: "query",
    required: true,
    schema: { type: "string", format: "date-time" },
    description: "Exclusive end, ISO8601. At most 31 days after `from`.",
  },
] as const;

const pageParams = [
  {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 500 },
    description:
      "Opt in to keyset pagination. Omitting it returns the full unpaged collection, exactly as before pagination existed.",
  },
  {
    name: "cursor",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "`nextCursor` from the previous page.",
  },
] as const;

const errorResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
    },
  },
});

const rateLimited = {
  description:
    "Rate limit exceeded for the scope this route charges against. Carries `Retry-After` in seconds.",
  headers: {
    "Retry-After": { schema: { type: "integer" }, description: "Seconds until a token is available." },
  },
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { error: { type: "string" }, retryAfter: { type: "integer" } },
        required: ["error", "retryAfter"],
      },
    },
  },
};

const common = {
  401: errorResponse("Missing, malformed, revoked or expired API key."),
  403: errorResponse("The key's scopes do not cover this route."),
  429: rateLimited,
};

const jsonObject = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

export function openApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "VoltTrade Cloud REST API",
      version: "1.0.0",
      description:
        "Read access to sites, devices, telemetry and alarms, plus EMS plan push. " +
        "Every request needs `Authorization: Bearer etk_...`. Responses are scoped to " +
        "the key's organization.\n\n" +
        "Rate limits are per key AND per scope: a telemetry range scan and a device " +
        "listing do not cost the same, so they do not share a budget. Every response " +
        "carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Scope`.\n\n" +
        "For push instead of poll, see the signed webhook subscriptions in docs/api-v1.md; " +
        `the events are: ${WEBHOOK_EVENTS.join(", ")}.`,
    },
    servers: [{ url: "/api/v1" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "etk_<48 hex>" },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/openapi.json": {
        get: {
          summary: "This document",
          description: "The spec itself. Requires a key like every other route.",
          responses: { 200: jsonObject("OpenAPI 3.1 document."), ...common },
        },
      },
      "/sites": {
        get: {
          summary: "List sites",
          description: "Every site belonging to the key's organization.",
          responses: { 200: jsonObject("`{ sites: [...] }`"), ...common },
        },
      },
      "/devices": {
        get: {
          summary: "List devices",
          description: "Meters with their gateway and site context.",
          parameters: [...pageParams],
          responses: { 200: jsonObject("`{ devices: [...], nextCursor }`"), ...common },
        },
      },
      "/devices/{id}/latest": {
        get: {
          summary: "Latest telemetry for one device",
          parameters: [deviceIdParam],
          responses: {
            200: jsonObject("`{ deviceId, ts, values }`"),
            404: errorResponse("Unknown device, or one outside the key's organization."),
            ...common,
          },
        },
      },
      "/devices/{id}/energy": {
        get: {
          summary: "Settlement energy intervals",
          description:
            "A consecutive UTC-aligned grid: empty buckets are PRESENT with null values, " +
            "so a gap and a measured zero can never be confused. `quality` is `measured` " +
            "or `estimated`.",
          parameters: [
            deviceIdParam,
            ...isoRange,
            {
              name: "bucketMin",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 15, maximum: 1440, default: 60 },
              description: "Interval length in minutes.",
            },
          ],
          responses: {
            200: jsonObject("`{ deviceId, from, to, bucketMin, buckets[] }`"),
            400: errorResponse("Missing or unparsable range, range over 31 days, or bad bucketMin."),
            404: errorResponse("Unknown device."),
            ...common,
          },
        },
      },
      "/devices/{id}/telemetry": {
        get: {
          summary: "Multi-metric bucketed series",
          description:
            "Requires the `telemetry:read` scope IN ADDITION to `read`, and is rate limited " +
            "against that scope — a range scan costs more than a row lookup. Empty buckets " +
            "are present with all keys null and `samples: 0`.",
          parameters: [
            deviceIdParam,
            ...isoRange,
            {
              name: "keys",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "1–16 comma-separated metric keys, e.g. `activePowerKw,socPct`.",
            },
            {
              name: "bucketMin",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 1440, default: 15 },
            },
          ],
          responses: {
            200: jsonObject("`{ deviceId, from, to, bucketMin, keys, buckets[] }`"),
            400: errorResponse("Bad range, bad bucketMin, or an invalid/oversized key list."),
            404: errorResponse("Unknown device."),
            ...common,
          },
        },
      },
      "/devices/{id}/ems-plan": {
        get: {
          summary: "Active or next EMS plan",
          parameters: [deviceIdParam],
          responses: {
            200: jsonObject("`{ plan }` — null when the device has none."),
            404: errorResponse("Unknown device."),
            ...common,
          },
        },
        put: {
          summary: "Push an EMS plan",
          description:
            "Requires the `ems:write` scope IN ADDITION to `control`, and is rate limited " +
            "against it. Upsert: a new plan supersedes overlapping ones for the same device. " +
            "Span at most 48 hours.",
          parameters: [deviceIdParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["validFrom", "validTo", "setpoints"],
                  properties: {
                    validFrom: { type: "string", format: "date-time" },
                    validTo: { type: "string", format: "date-time" },
                    source: { type: "string", maxLength: 64 },
                    setpoints: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          at: { type: "string", format: "date-time" },
                          mode: { type: "string", enum: ["charge", "discharge", "idle"] },
                          targetKw: { type: "number", nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: jsonObject("`{ planId, status, superseded }`"),
            400: errorResponse("Missing body, bad timestamps, span over 48h, or bad setpoints."),
            404: errorResponse("Unknown device."),
            ...common,
          },
        },
      },
      "/alarms": {
        get: {
          summary: "List alarms",
          parameters: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["active", "acknowledged", "resolved", "all"], default: "active" },
            },
            ...pageParams,
          ],
          responses: {
            200: jsonObject("`{ alarms: [...], nextCursor }`"),
            400: errorResponse("Unknown status value."),
            ...common,
          },
        },
      },
    },
  };
}
