import mqtt from "mqtt";
const tryConn = (opts, label) => new Promise((res) => {
  const c = mqtt.connect("mqtt://localhost:1883", { ...opts, reconnectPeriod: 0, connectTimeout: 3000 });
  const done = (msg) => { console.log(label + ": " + msg); try { c.end(true); } catch {} res(null); };
  c.on("connect", () => done("CONNECTED"));
  c.on("error", (e) => done("REJECTED (" + e.message + ")"));
  setTimeout(() => done("TIMEOUT"), 5000);
});
await tryConn({}, "anonymous");
await tryConn({ username: "probe", password: "wrong" }, "bad-creds ");
await tryConn({ username: "probe", password: "probe-pass" }, "good-creds ");
process.exit(0);
