#!/usr/bin/env python3
# v7/C1 probe: auth enforcement, RBAC, audit log.
import json, urllib.request, urllib.parse, http.cookiejar

BASE = "http://localhost:3000/api/trpc/"

def client():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj

def call(op, proc, payload=None, method=None):
    url = BASE + proc + "?batch=1"
    body = None
    headers = {}
    is_query = method == "GET"
    if is_query:
        url += "&input=" + urllib.parse.quote(json.dumps({"0": {"json": payload}}))
    else:
        body = json.dumps({"0": {"json": payload}}).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with op.open(req, timeout=15) as r:
            data = json.loads(r.read())[0]
            if "error" in data:
                return {"error": data["error"]["json"]["message"], "code": data["error"]["json"].get("code")}
            return {"data": data["result"]["data"]["json"]}
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read())[0]
            return {"error": data["error"]["json"]["message"], "code": data["error"]["json"].get("code")}
        except Exception:
            return {"error": f"HTTP {e.code}"}

results = []
def probe(name, ok, detail):
    results.append((name, ok))
    print("PASS" if ok else "FAIL", name, "->", json.dumps(detail)[:180])

anon, _ = client()
r = call(anon, "meters.list", None, "GET")
probe("anonymous query rejected", "error" in r and "Login required" in str(r), r)
r = call(anon, "sites.create", {"name": "x"})
probe("anonymous mutation rejected", "error" in r, r)

admin, _ = client()
r = call(admin, "auth.login", {"email": "admin@enertrek.local", "password": "wrong"})
probe("wrong password rejected", "error" in r and "Invalid" in str(r), r)
r = call(admin, "auth.login", {"email": "admin@enertrek.local", "password": "admin1234"})
probe("admin login", r.get("data", {}).get("role") == "admin", r)
r = call(admin, "auth.me", None, "GET")
probe("me after login", r.get("data", {}).get("user", {}).get("role") == "admin", r)
r = call(admin, "meters.list", None, "GET")
probe("authed query works", "data" in r, f"rows={len(r.get('data', []))}")

# admin creates a viewer + an operator. Tolerate re-runs: if the viewer exists
# from a previous run, creation must FAIL (unique email enforced) — both
# outcomes prove the path works; the login probes below verify the account.
r = call(admin, "auth.users", None, "GET")
viewer_exists = any(u.get("email") == "viewer@enertrek.local" for u in r.get("data", []))
r = call(admin, "auth.createUser", {"email": "viewer@enertrek.local", "name": "V", "password": "viewer123", "role": "viewer"})
probe("admin creates viewer", ("data" in r) if not viewer_exists else ("error" in r), {"preexisting": viewer_exists, "res": r})
viewer, _ = client()
call(viewer, "auth.login", {"email": "viewer@enertrek.local", "password": "viewer123"})
r = call(viewer, "meters.list", None, "GET")
probe("viewer can read", "data" in r, "ok" if "data" in r else r)
r = call(viewer, "sites.create", {"name": "forbidden"})
probe("viewer mutation forbidden", "error" in r and "Requires role" in str(r), r)
r = call(viewer, "auth.users", None, "GET")
probe("viewer cannot list users", "error" in r, r)

# audit: admin mutation produces an audit row
r = call(admin, "sites.create", {"name": "Audit Probe Site"})
site_id = r.get("data", {}).get("id")
import time; time.sleep(0.5)
r = call(admin, "auth.auditLog", {"limit": 10}, "GET")
rows = r.get("data", [])
hit = [a for a in rows if a.get("procedure") == "sites.create"]
probe("audit row written for mutation", len(hit) > 0 and hit[0].get("email") == "admin@enertrek.local",
      hit[0] if hit else rows[:1])
if site_id: call(admin, "sites.remove", {"id": site_id})

# logout kills the session
r = call(admin, "auth.logout", {})
r = call(admin, "auth.me", None, "GET")
probe("logout revokes session", r.get("data", {}).get("user") is None, r)

fails = [n for n, ok in results if not ok]
print(f"\n=== {len(results)-len(fails)}/{len(results)} passed" + (f" — FAILED: {fails}" if fails else ""))
