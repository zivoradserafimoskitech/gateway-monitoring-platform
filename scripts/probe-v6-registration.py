#!/usr/bin/env python3
# v6 probes: registration validation (B2/B3) + site binding (R7/R3).
# v7/C1: mutations now require an operator session — login as admin first.
import json, urllib.request, http.cookiejar

BASE = "http://localhost:3000/api/trpc/"
_cj = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj))

def call(proc, payload=None, method=None):
    url = BASE + proc + "?batch=1"
    body = None
    headers = {}
    if method == "POST" or method is None and payload is not None and not proc.endswith(("list", "mqttStatus")):
        # tRPC mutations require POST; queries accept GET with input in URL
        body = json.dumps({"0": {"json": payload}}).encode()
        headers["Content-Type"] = "application/json"
    elif payload is not None:
        url += "&input=" + urllib.parse.quote(json.dumps({"0": {"json": payload}}))
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with _opener.open(req, timeout=15) as r:
            data = json.loads(r.read())[0]
            if "error" in data:
                return {"error": data["error"]["json"]["message"]}
            return {"data": data["result"]["data"]["json"]}
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read())[0]
            return {"error": data["error"]["json"]["message"]}
        except Exception:
            return {"error": f"HTTP {e.code}"}

import urllib.parse
results = []

# v7/C1: authenticate as admin (operator-capable) before any mutation.
_login = call("auth.login", {"email": "admin@enertrek.local", "password": "admin1234"})
assert "data" in _login, f"admin login failed: {_login}"

def probe(name, res, expect_error_substr=None):
    if expect_error_substr:
        ok = "error" in res and expect_error_substr.lower() in str(res["error"]).lower()
    else:
        ok = "data" in res
    results.append((name, ok, res))
    print(("PASS" if ok else "FAIL"), name, "->", json.dumps(res)[:220])

# B2: gateway uid charset
probe("gw uid with '/'", call("gateways.create", {"uid": "bad/uid", "name": "x", "model": "G30"}), "letters, digits")
probe("gw uid too short", call("gateways.create", {"uid": "ab", "name": "x", "model": "G30"}), "4-64")
probe("gw uid with space", call("gateways.create", {"uid": "bad uid", "name": "x", "model": "G30"}), "letters, digits")
ok = call("gateways.create", {"uid": "gw-v6probe", "name": "V6 probe", "model": "G30"})
probe("gw create valid", ok)
gwid = ok.get("data", {}).get("id")
probe("gw duplicate uid", call("gateways.create", {"uid": "gw-v6probe", "name": "y", "model": "C30"}), "already exists")
probe("gw bad topicPrefix", call("gateways.create", {"uid": "gw-v6probe2", "name": "z", "model": "G30", "topicPrefix": "bad prefix#"}), "Topic prefix")

# B3: meter model + host validation
probe("meter unknown model", call("meters.create", {"name": "x", "model": "TYPO-3000", "deviceType": "meter", "host": "127.0.0.1"}), "Unknown model")
probe("meter bad host", call("meters.create", {"name": "x", "model": "PEM3000", "deviceType": "meter", "host": "not a host!!"}), "IPv4")
probe("meter unknown site", call("meters.create", {"name": "x", "model": "PEM3000", "deviceType": "meter", "host": "127.0.0.1", "port": 5999, "siteId": 999999}), "Site not found")

# R7: site binding for direct-TCP device
site = call("sites.create", {"name": "V6 Probe Site"})
probe("site create", site)
siteid = site.get("data", {}).get("id")
m = call("meters.create", {"name": "V6 Probe Meter", "model": "PEM3000", "deviceType": "meter",
                           "host": "127.0.0.1", "port": 5199, "unitId": 7, "siteId": siteid, "pollIntervalSec": 5})
probe("meter create with siteId", m)
mid = m.get("data", {}).get("id")
lst = call("meters.list")
row = [r for r in lst.get("data", []) if r.get("id") == mid]
probe("meter list shows siteName", {"data": row[0]["siteName"]} if row and row[0].get("siteName") == "V6 Probe Site" else {"error": f"siteName={row[0].get('siteName') if row else 'row-missing'}"})

# R3: site delete unbinds
rm = call("sites.remove", {"id": siteid})
probe("site remove unbinds", {"data": rm.get("data")} if rm.get("data", {}).get("unboundMeters") == 1 else rm)

# cleanup probes
if mid: call("meters.remove", {"id": mid})
if gwid: call("gateways.remove", {"id": gwid})

fails = [n for n, ok, _ in results if not ok]
print(f"\n=== {len(results) - len(fails)}/{len(results)} passed" + (f" — FAILED: {fails}" if fails else ""))
