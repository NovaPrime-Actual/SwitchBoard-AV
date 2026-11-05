// SPDX-License-Identifier: AGPL-3.0-or-later
// The Query tester can ask a source (encoder) as well as a screen, but only addresses in the device list,
// and only an admin may use it. Runs against the 127.x mock decoders (never real devices).
import { spawn, fork } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-qt-"));
const PORT = 18710;
const env = {
  ...process.env,
  DEVICES_FILE: path.join(app, "test/devices.test.json"),
  DATA_DIR: path.join(tmp, "d"),
  BIND: "127.0.0.1",
  PORT: String(PORT),
  TLS: "off",
  STATUS_POLL_SECONDS: "0",
};
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(extra).slice(0, 300)}`,
  );
};

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

(async () => {
  const mock = fork(path.join(app, "test", "mock-decoders.js"), [], {
    cwd: app,
    env,
    silent: true,
  });
  await new Promise((r) => mock.once("message", r));
  const child = spawn(process.execPath, [path.join(app, "server.js")], {
    cwd: app,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => {
    const t = setInterval(() => {
      if (/Open http/.test(out)) {
        clearInterval(t);
        r();
      }
    }, 100);
    setTimeout(r, 8000);
  });

  const admin = client();
  const pw = /temporary password: (\S+)/.exec(out)[1];
  await admin("POST", "/api/login", { username: "admin", password: pw });
  await admin("POST", "/api/change-password", {
    currentPassword: pw,
    newPassword: "admin-test-pass-1",
  });
  await admin("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });

  // the page's own list has both kinds for the tester's dropdown
  let r = await admin("GET", "/api/devices");
  check(
    "the page data lists screens and sources",
    r.status === 200 && r.json.decoders.length === 5 && r.json.sources.length === 3,
    r.json && { d: r.json.decoders.length, s: r.json.sources.length },
  );

  r = await admin("POST", "/api/test-query", { deviceIp: "127.0.1.11", key: "STREAM.HOST" });
  check(
    "a screen can be queried",
    r.status === 200 && r.json.replies.some((t) => /SUCCESS_QUERY_KEY/.test(t)),
    r,
  );
  r = await admin("POST", "/api/test-query", { deviceIp: "127.0.2.11", key: "STREAM.HOST" });
  check(
    "a source (encoder) can be queried",
    r.status === 200 && r.json.replies.some((t) => /SUCCESS_QUERY_KEY/.test(t)),
    r,
  );
  r = await admin("POST", "/api/test-query", { deviceIp: "127.0.2.11", diag: "TEMPERATURE" });
  check(
    "a quick-pick query works on a source",
    r.status === 200 && Array.isArray(r.json.replies),
    r,
  );
  r = await admin("POST", "/api/test-query", { deviceIp: "127.0.9.9", key: "STREAM.HOST" });
  check(
    "an address that is not in the device list is refused",
    r.status === 400 && /Unknown device/.test(r.json.error),
    r,
  );
  r = await admin("POST", "/api/test-query", { deviceIp: "127.0.2.11", key: "A&B=1" });
  check("a key with odd characters is still refused", r.status === 400, r);

  const crew = client();
  const made = (
    await admin("POST", "/api/admin/users", { name: "Pat", username: "pat", role: "user" })
  ).json;
  await crew("POST", "/api/login", { username: "pat", password: made.tempPassword });
  await crew("POST", "/api/change-password", {
    currentPassword: made.tempPassword,
    newPassword: "pat-test-pass-1",
  });
  r = await crew("POST", "/api/test-query", { deviceIp: "127.0.2.11", key: "STREAM.HOST" });
  check("a person who is not an admin cannot use it", r.status === 403, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  child.kill();
  mock.kill();
  setTimeout(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }, 400);
})();
