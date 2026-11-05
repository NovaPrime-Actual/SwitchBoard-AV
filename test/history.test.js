// How many earlier versions of the device list are kept: choices, trimming, validation, persistence.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-hist-"));
const PORT = 18580;
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(extra).slice(0, 300)}`,
  );
};

function start(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(app, "server.js")], {
      cwd: app,
      env: {
        ...process.env,
        DEVICES_FILE: path.join(app, "test/devices.test.json"),
        DATA_DIR: dir,
        BIND: "127.0.0.1",
        PORT: String(PORT),
        TLS: "off",
        STATUS_POLL_SECONDS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setInterval(() => {
      if (/Open http/.test(out)) {
        clearInterval(t);
        resolve({ child, out: () => out });
      }
    }, 100);
    setTimeout(() => {
      clearInterval(t);
      resolve({ child, out: () => out });
    }, 8000);
  });
}
const stop = (s) =>
  new Promise((r) => {
    if (s.child.exitCode !== null) return r();
    s.child.on("exit", () => r());
    s.child.kill();
    setTimeout(r, 2000);
  });

function client() {
  let cookie = "";
  return (method, url, body) =>
    new Promise((resolve) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          method,
          host: "127.0.0.1",
          port: PORT,
          path: url,
          headers: {
            cookie,
            "content-type": "application/json",
            ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
          },
        },
        (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => {
            const sc = res.headers["set-cookie"];
            if (sc) cookie = sc.map((c) => c.split(";")[0]).join("; ");
            let json;
            try {
              json = JSON.parse(b);
            } catch {
              json = null; // the body is not JSON
            }
            resolve({ status: res.statusCode, json });
          });
        },
      );
      req.on("error", (e) => resolve({ error: e.code }));
      if (data) req.write(data);
      req.end();
    });
}
async function firstLogin(c, out) {
  const pw = /temporary password: (\S+)/.exec(out)[1];
  await c("POST", "/api/login", { username: "admin", password: pw });
  await c("POST", "/api/change-password", {
    currentPassword: pw,
    newPassword: "admin-test-pass-1",
  });
  await c("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
}
const D = "/api/admin/devices";

(async () => {
  const dir = path.join(tmp, "d");
  let s = await start(dir);
  const admin = client();
  await firstLogin(admin, s.out());

  let r = await admin("GET", D);
  check(
    "default is the last 10 changes, with four choices",
    r.json.historyKeep === 10 && JSON.stringify(r.json.historyChoices) === "[5,10,15,20]",
    [r.json.historyKeep, r.json.historyChoices],
  );

  // 14 changes: only the 10 most recent are kept
  for (let i = 1; i <= 14; i++) await admin("POST", D + "/spaces", { name: `Room ${i}` });
  r = await admin("GET", D);
  check(
    "after 14 changes only 10 versions are kept, newest first",
    r.json.history.length === 10 &&
      /Room 14/.test(r.json.history[0].reason) &&
      /Room 5/.test(r.json.history[9].reason),
    r.json.history.map((h) => h.reason),
  );
  check(
    "the file on disk is capped too",
    JSON.parse(fs.readFileSync(path.join(dir, "devices-history.json"), "utf8")).length === 10,
  );

  // choosing fewer drops the oldest now
  r = await admin("POST", D + "/history-limit", { keep: 5 });
  check(
    "choosing 5 reports how many were dropped",
    r.status === 200 && r.json.historyKeep === 5 && r.json.dropped === 5,
    r.json,
  );
  r = await admin("GET", D);
  check(
    "only the 5 newest remain",
    r.json.historyKeep === 5 &&
      r.json.history.length === 5 &&
      /Room 14/.test(r.json.history[0].reason) &&
      /Room 10/.test(r.json.history[4].reason),
    r.json.history.map((h) => h.reason),
  );
  await admin("POST", D + "/spaces", { name: "Another" });
  r = await admin("GET", D);
  check(
    "new changes keep it at 5",
    r.json.history.length === 5 && /Another/.test(r.json.history[0].reason),
  );

  // choosing more drops nothing and the history grows again
  r = await admin("POST", D + "/history-limit", { keep: 20 });
  check("choosing 20 drops nothing", r.status === 200 && r.json.dropped === 0, r.json);
  for (let i = 1; i <= 3; i++) await admin("POST", D + "/spaces", { name: `More ${i}` });
  r = await admin("GET", D);
  check("and the history grows past 5 again", r.json.history.length === 8, r.json.history.length);

  // validation
  for (const [label, keep] of [
    ["0", 0],
    ["7", 7],
    ["30", 30],
    ["negative", -5],
    ["text", "lots"],
    ["missing", undefined],
    ["null", null],
    ["a list", [5]],
  ]) {
    r = await admin("POST", D + "/history-limit", { keep });
    check(`refused: ${label}`, r.status === 400 && /Choose one of/.test(r.json.error), r.json);
  }
  r = await admin("GET", D);
  check(
    "refused requests changed nothing",
    r.json.historyKeep === 20 && r.json.history.length === 8,
  );

  // admin only
  const made = (
    await admin("POST", "/api/admin/users", {
      name: "Pat",
      username: "pat",
      role: "user",
      groups: [],
    })
  ).json;
  const pat = client();
  await pat("POST", "/api/login", { username: "pat", password: made.tempPassword });
  await pat("POST", "/api/change-password", {
    currentPassword: made.tempPassword,
    newPassword: "pat-test-pass-1",
  });
  await pat("POST", "/api/login", { username: "pat", password: "pat-test-pass-1" });
  r = await pat("POST", D + "/history-limit", { keep: 5 });
  check("non-admin cannot change it", r.status === 403, r.status);

  // logged
  r = await admin("GET", "/api/admin/activity");
  check(
    "changes to the setting are in the activity log (with how many were dropped)",
    r.json.some(
      (e) =>
        e.type === "admin_device" &&
        /keep the last 5 list changes \(dropped 5 older\)/.test(e.detail),
    ) && r.json.some((e) => /keep the last 20 list changes$/.test(e.detail || "")),
    r.json.slice(0, 8).map((e) => e.detail),
  );

  // persists across a restart (stored in store.json)
  await admin("POST", D + "/history-limit", { keep: 15 });
  await stop(s);
  s = await start(dir);
  const a2 = client();
  await a2("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
  r = await a2("GET", D);
  check("the choice survives a restart", r.json.historyKeep === 15 && r.json.history.length === 8, [
    r.json.historyKeep,
    r.json.history.length,
  ]);
  check(
    "...and is in store.json, so a full backup carries it",
    JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8")).settings.deviceHistoryKeep ===
      15,
  );
  await stop(s);

  // an older, longer history is trimmed to the default at start-up
  const dir2 = path.join(tmp, "d2");
  let s2 = await start(dir2);
  const pw2 = /temporary password: (\S+)/.exec(s2.out())[1];
  await stop(s2); // creates the data folder with the imported list
  const base = JSON.parse(fs.readFileSync(path.join(dir2, "devices.store.json"), "utf8"));
  const old = Array.from({ length: 25 }, (_, i) => ({
    at: 1000 + i,
    by: "admin",
    reason: `old change ${i + 1}`,
    decoders: base.decoders,
    encoders: base.encoders,
    spaces: base.spaces,
  }));
  fs.writeFileSync(path.join(dir2, "devices-history.json"), JSON.stringify(old));
  s2 = await start(dir2);
  const a3 = client();
  await a3("POST", "/api/login", { username: "admin", password: pw2 });
  await a3("POST", "/api/change-password", {
    currentPassword: pw2,
    newPassword: "admin-test-pass-3",
  });
  await a3("POST", "/api/login", { username: "admin", password: "admin-test-pass-3" });
  r = await a3("GET", D);
  check(
    "a 25-entry history from an older version is trimmed to the default 10 at start",
    r.json.history.length === 10 &&
      /old change 25/.test(r.json.history[0].reason) &&
      /old change 16/.test(r.json.history[9].reason),
    r.json.history.map((h) => h.reason),
  );
  check(
    "...on disk too",
    JSON.parse(fs.readFileSync(path.join(dir2, "devices-history.json"), "utf8")).length === 10,
  );
  await stop(s2);

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
