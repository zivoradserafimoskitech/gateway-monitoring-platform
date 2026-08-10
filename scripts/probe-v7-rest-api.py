#!/usr/bin/env python3
"""v7/C11 probe: public REST API + API keys.

 1. admin login → apiKeys.create (viewer) returns a raw etk_ key ONCE
 2. /api/v1/devices without key → 401; with garbage key → 401
 3. with the key → 200; devices carry effectiveSiteId (v6 coalesce)
 4. /api/v1/devices/:id/latest → 200 with values; /sites and /alarms → 200
 5. apiKeys.list shows prefix + lastUsedAt (never the raw key)
 6. apiKeys.revoke → key immediately rejected (401)
"""
import json
import urllib.parse
import urllib.request
import urllib.error
import http.cookiejar
import sys

BASE = "http://localhost:3000"
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

fails = 0

def probe(name, ok, detail):
    global fails
    print(("PASS" if ok else "FAIL"), name, "->", json.dumps(detail)[:220] if detail is not None else "")
    if not ok:
        fails += 1

def trpc_mut(proc, payload):
    req = urllib.request.Request(
        f"{BASE}/api/trpc/{proc}?batch=1",
        data=json.dumps({"0": {"json": payload}}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with opener.open(req) as r:
        body = json.loads(r.read())
    if isinstance(body, list):
        body = body[0]
    if "error" in body:
        raise RuntimeError(body["error"])
    return body["result"]["data"]["json"]

def v1(path, key=None):
    req = urllib.request.Request(f"{BASE}/api/v1{path}")
    if key:
        req.add_header("authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None

# 1. login + create key
trpc_mut("auth.login", {"email": "admin@enertrek.local", "password": "admin1234"})
created = trpc_mut("apiKeys.create", {"name": "probe-key", "role": "viewer"})
raw = created["key"]
probe("apiKeys.create returns raw etk_ key once", raw.startswith("etk_") and len(raw) > 40, {"prefix": created["prefix"]})

# 2. unauth
s1, _ = v1("/devices")
s2, _ = v1("/devices", key="etk_garbagegarbagegarbage")
probe("no key → 401, garbage key → 401", s1 == 401 and s2 == 401, {"noKey": s1, "garbage": s2})

# 3. devices
s3, devs = v1("/devices", key=raw)
d0 = (devs or {}).get("devices", [{}])[0]
probe(
    "devices → 200, includes effectiveSiteId + gateway context",
    s3 == 200 and "effectiveSiteId" in d0 and "gatewayUid" in d0 and len(devs["devices"]) >= 15,
    {"status": s3, "count": len((devs or {}).get("devices", [])), "sample": {k: d0.get(k) for k in ("id", "model", "effectiveSiteId")}},
)

# 4. latest / sites / alarms
dev_id = d0.get("id", 1)
s4, latest = v1(f"/devices/{dev_id}/latest", key=raw)
latest_ok = s4 == 200 and "latest" in latest and (latest["latest"] is None or "values" in latest["latest"])
probe("devices/:id/latest → 200 with values", latest_ok, {"status": s4, "hasValues": bool((latest or {}).get("latest"))})
s5, sites = v1("/sites", key=raw)
probe("sites → 200", s5 == 200 and "sites" in (sites or {}), {"status": s5, "count": len((sites or {}).get("sites", []))})
s6, alarms = v1("/alarms", key=raw)
probe("alarms → 200 (default active)", s6 == 200 and "alarms" in (alarms or {}), {"status": s6, "count": len((alarms or {}).get("alarms", []))})
s7, _ = v1("/alarms?status=bogus", key=raw)
probe("alarms?status=bogus → 400", s7 == 400, {"status": s7})
s8, nf = v1("/devices/999999999/latest", key=raw)
probe("unknown device → 404", s8 == 404, {"status": s8})

# 5. list shows prefix + lastUsedAt, never raw (query → GET with input in URL)
req = urllib.request.Request(
    f"{BASE}/api/trpc/apiKeys.list?batch=1&input={urllib.parse.quote(json.dumps({'0': {'json': None, 'meta': {'values': ['undefined']}}}))}"
)
with opener.open(req) as r:
    raw_body = json.loads(r.read())
lst = (raw_body[0] if isinstance(raw_body, list) else raw_body)["result"]["data"]["json"]
row = next((k for k in lst if k["id"] == created["id"]), None)
probe(
    "apiKeys.list shows prefix + lastUsedAt, never raw key",
    row is not None and row["prefix"] == raw[:12] and row.get("lastUsedAt") is not None and raw not in json.dumps(lst),
    {"prefix": (row or {}).get("prefix"), "lastUsedAt": bool((row or {}).get("lastUsedAt"))},
)

# 6. revoke → 401
trpc_mut("apiKeys.revoke", {"id": created["id"]})
s9, _ = v1("/devices", key=raw)
probe("revoked key → 401 immediately", s9 == 401, {"status": s9})

print("=== ALL PASS" if fails == 0 else f"=== {fails} FAILURES")
sys.exit(0 if fails == 0 else 1)
