#!/usr/bin/env python3
# v8 ERP integration — end-to-end contract simulation.
# Replicates EXACTLY what supabase/functions/sync-enertrek-meters and
# sync-enertrek-assets do on the Enertrek side (same URLs, same headers,
# same field extraction), against the LIVE dev server, and asserts the
# contract the Deno functions rely on. No Supabase needed — this proves the
# Enertrek half of the wire.
import json, sys, urllib.request, urllib.error

BASE = "http://localhost:3000"
ADMIN_EMAIL, ADMIN_PW = "admin@enertrek.local", "admin1234"
checks = []

def check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))
    print(("PASS" if ok else "FAIL"), name, ("-> " + str(detail)[:160] if detail else ""))

def req(method, path, token=None, body=None, key=None):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header("Content-Type", "application/json")
    if token: r.add_header("x-session-token", token)
    if key: r.add_header("Authorization", "Bearer " + key)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, data=data, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}

def trpc_proc(path, token, payload=None, query=False):
    if query:
        import urllib.parse
        q = urllib.parse.quote(json.dumps({"0": {"json": payload}}))
        s, r = req("GET", f"/api/trpc/{path}?batch=1&input={q}", token=token)
    else:
        s, r = req("POST", f"/api/trpc/{path}?batch=1", token=token, body={"0": {"json": payload}})
    row = r[0] if isinstance(r, list) else r
    return s, row

# 1) admin login -> session token
s, r = trpc_proc("auth.login", None, {"email": ADMIN_EMAIL, "password": ADMIN_PW})
token = (((r or {}).get("result") or {}).get("data") or {}).get("json", {}).get("token")
check("admin login returns session token", s == 200 and token)

# 2) create a temporary API key (viewer = read-only, like the ERP will use)
s, r = trpc_proc("apiKeys.create", token, {"name": "erp-sim-probe", "role": "viewer"})
j = (((r or {}).get("result") or {}).get("data") or {}).get("json") or {}
api_key, key_id = j.get("key"), j.get("id")
check("apiKeys.create returns etk_ key once", s == 200 and isinstance(api_key, str) and api_key.startswith("etk_"), j.get("error") or key_id)

DEVICE = 30013  # huawei-sun2000 inverter meter (live on plant sim 5021)
try:
    # 3) contract: /api/v1/devices (shape the assets function parses)
    s, r = req("GET", "/api/v1/devices", key=api_key)
    devs = (r or {}).get("devices") or []
    d30013 = next((d for d in devs if d.get("id") == DEVICE), None)
    check("GET /devices 200 + devices[]", s == 200 and isinstance(devs, list) and len(devs) > 0, f"{len(devs)} devices")
    check("device has id/name/model/deviceType/status", d30013 is not None and all(k in d30013 for k in ("id","name","model","deviceType","status")), d30013)

    # 4) contract: /devices/:id/latest (values dict with energyImportKwh/activePowerKw)
    s, r = req("GET", f"/api/v1/devices/{DEVICE}/latest", key=api_key)
    vals = (r or {}).get("values") or {}
    check("GET /devices/:id/latest 200 + ts + values", s == 200 and r.get("ts") and isinstance(vals, dict), list(vals.keys())[:8])
    check("latest has numeric values (activePowerKw or energyImportKwh)", any(k in vals for k in ("activePowerKw","energyImportKwh","energyExportKwh")))

    # 5) contract: /devices/:id/energy — 2h window, 15-min buckets (the meters sync call)
    import datetime
    to = datetime.datetime.now(datetime.timezone.utc)
    frm = to - datetime.timedelta(hours=2)
    q = f"from={urllib.parse.quote(frm.isoformat())}&to={urllib.parse.quote(to.isoformat())}&bucketMin=15"
    s, r = req("GET", f"/api/v1/devices/{DEVICE}/energy?{q}", key=api_key)
    buckets = (r or {}).get("buckets") or []
    check("GET /energy 200 + buckets[]", s == 200 and isinstance(buckets, list), f"{len(buckets)} buckets")
    check("bucket count 8..9 (2h/15m, floor..ceil grid)", 8 <= len(buckets) <= 9, len(buckets))
    if buckets:
        b0 = buckets[0]
        check("bucket fields ts/importKwh/exportKwh/avgPowerKw/quality", all(k in b0 for k in ("ts","importKwh","exportKwh","avgPowerKw","quality")), b0)
        nn = all((b.get("importKwh") is None or b["importKwh"] >= 0) and (b.get("exportKwh") is None or b["exportKwh"] >= 0) for b in buckets)
        check("all deltas non-negative (counter-reset safe)", nn)
        check("quality in {measured,estimated}", all(b.get("quality") in ("measured","estimated") for b in buckets))
        iso_ok = all(str(b.get("ts","")).startswith("20") for b in buckets)
        check("bucket ts are ISO timestamps", iso_ok)

    # 6) contract: hourly buckets over yesterday (assets sync call shape)
    frm2 = to - datetime.timedelta(hours=26)
    q2 = f"from={urllib.parse.quote(frm2.isoformat())}&to={urllib.parse.quote(to.isoformat())}&bucketMin=60"
    s, r = req("GET", f"/api/v1/devices/{DEVICE}/energy?{q2}", key=api_key)
    check("GET /energy hourly window OK", s == 200 and len((r or {}).get("buckets") or []) >= 24, len((r or {}).get("buckets") or []))

    # 7) error contract: 404 unknown device, 400 bad range/bucket, 401 no key
    s, r = req("GET", "/api/v1/devices/99999999/energy?" + q, key=api_key)
    check("unknown device -> 404 {error}", s == 404 and "error" in (r or {}), s)
    far = to - datetime.timedelta(days=40)
    s, r = req("GET", f"/api/v1/devices/{DEVICE}/energy?from={urllib.parse.quote(far.isoformat())}&to={urllib.parse.quote(to.isoformat())}&bucketMin=15", key=api_key)
    check(">31d range -> 400 {error}", s == 400 and "error" in (r or {}), s)
    s, r = req("GET", f"/api/v1/devices/{DEVICE}/energy?" + q)
    check("no key -> 401", s == 401, s)
finally:
    if key_id:
        s, r = trpc_proc("apiKeys.revoke", token, {"id": key_id})
        check("cleanup: probe key revoked", s == 200)
        s, r = req("GET", f"/api/v1/devices/{DEVICE}/latest", key=api_key)
        check("revoked key -> 401", s == 401, s)

fails = [c for c in checks if not c[1]]
print(f"\n=== {len(checks)-len(fails)}/{len(checks)} passed" + (" — FAILURES: " + ", ".join(c[0] for c in fails) if fails else " — ALL PASS"))
sys.exit(1 if fails else 0)
