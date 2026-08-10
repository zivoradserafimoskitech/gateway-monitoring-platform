#!/usr/bin/env python3
# v7/C2 probe: alarm notifications — webhook sink, escalation, maintenance.
import json, urllib.request, urllib.parse, http.cookiejar, threading, time, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

RECEIVED = []

class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        RECEIVED.append((self.path, json.loads(body or b"{}")))
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass

srv = HTTPServer(("127.0.0.1", 9900), Sink)
threading.Thread(target=srv.serve_forever, daemon=True).start()

BASE = "http://localhost:3000/api/trpc/"
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def call(proc, payload=None, method=None):
    url = BASE + proc + "?batch=1"
    body = None; headers = {}
    if method == "GET":
        url += "&input=" + urllib.parse.quote(json.dumps({"0": {"json": payload}}))
    else:
        body = json.dumps({"0": {"json": payload}}).encode(); headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers)
    with op.open(req, timeout=15) as r:
        data = json.loads(r.read())[0]
        return data.get("error", {}).get("json") or data["result"]["data"]["json"]

results = []
def probe(name, ok, detail):
    results.append((name, ok)); print("PASS" if ok else "FAIL", name, "->", json.dumps(detail)[:160])

call("auth.login", {"email": "admin@enertrek.local", "password": "admin1234"})

ch1 = call("notifications.createChannel", {"name": "probe-hook", "type": "webhook", "target": "http://127.0.0.1:9900/hook"})
probe("create webhook channel", "id" in ch1, ch1)
ch2 = call("notifications.createChannel", {"name": "probe-esc", "type": "webhook", "target": "http://127.0.0.1:9900/esc", "escalation": True})
probe("create escalation channel", "id" in ch2, ch2)

# Breaching rule: PEM3000 #1 (id 1) reports activePowerKw > 0 via MQTT sim
rule = call("alarms.createRule", {"name": "V7 notify probe", "metric": "activePowerKw", "operator": "gt", "threshold": 0.000001, "severity": "warning", "meterId": 1})
probe("create breaching rule", "id" in rule, rule)
rule_id = rule.get("id")

# wait for ingestion → alarm → notification
alarm_id = None
for _ in range(20):
    time.sleep(2)
    lst = call("alarms.list", {"status": "active"}, "GET")
    mine = [a for a in (lst if isinstance(lst, list) else lst.get("alarms", [])) if a.get("ruleId") == rule_id]
    if mine: alarm_id = mine[0]["id"]; break
probe("alarm activated", alarm_id is not None, {"alarmId": alarm_id})

time.sleep(3)
hooks = [p for p, b in RECEIVED if p == "/hook" and b.get("alarmId") == alarm_id]
probe("initial webhook delivered", len(hooks) > 0, RECEIVED[-1] if RECEIVED else None)

fails = [n for n, ok in results if not ok]
print(json.dumps({"alarmId": alarm_id, "ruleId": rule_id, "ch1": ch1.get("id"), "ch2": ch2.get("id")}))
print(f"=== {len(results)-len(fails)}/{len(results)} passed" + (f" — FAILED: {fails}" if fails else ""))
sys.exit(1 if fails else 0)
