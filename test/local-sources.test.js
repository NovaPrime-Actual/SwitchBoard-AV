// Local sources: tied to a space, visible and switchable only for screens in that space.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-local-"));
const PORT = 18535;
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
  const child = spawn(process.execPath, [path.join(app, "server.js")], {
    cwd: app,
    env: {
      ...process.env,
      DEVICES_FILE: path.join(app, "test/devices.test.json"),
      DATA_DIR: path.join(tmp, "d"),
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
  await admin("POST", "/api/change-password", { currentPassword: pw, newPassword: "admin-test-pass-1" });
  await admin("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });

  let r = await admin("POST", "/api/admin/devices/encoders", {
    name: "Space A Laptop",
    ip: "127.0.2.14",
    space: "Space A",
  });
  check("admin can add a local source", r.status === 200, r.json);
  r = await admin("POST", "/api/admin/devices/encoders", {
    name: "Bad",
    ip: "127.0.2.15",
    space: "x".repeat(65),
  });
  check("overlong local space name is refused", r.status === 400, r.json);

  const mk = async (name, spaces, sources) => {
    const g = (await admin("POST", "/api/admin/groups", { name, spaces, sources })).json;
    const u = (
      await admin("POST", "/api/admin/users", { name, username: name.toLowerCase(), role: "user", groups: [g.id] })
    ).json;
    const c = client();
    await c("POST", "/api/login", { username: name.toLowerCase(), password: u.tempPassword });
    await c("POST", "/api/change-password", { currentPassword: u.tempPassword, newPassword: "user-test-pass-1" });
    await c("POST", "/api/login", { username: name.toLowerCase(), password: "user-test-pass-1" });
    return c;
  };
  const a = await mk("Alpha", ["Space A"], "all");
  const b = await mk("Bravo", ["Space B"], "all");

  const names = async (c) => (await c("GET", "/api/devices")).json.sources.map((s) => s.name);
  const aNames = await names(a);
  const bNames = await names(b);
  check("space A user sees the local source", aNames.includes("Space A Laptop"), aNames);
  check("space B user does not see it", !bNames.includes("Space A Laptop"), bNames);
  check("shared sources still visible to both", aNames.includes("Source 1") && bNames.includes("Source 1"), [aNames, bNames]);

  const noAll = await mk("Charlie", ["Space B"], ["127.0.2.14"]);
  check("naming a local source in a group's list does not grant it", !(await names(noAll)).includes("Space A Laptop"), await names(noAll));

  r = await b("POST", "/api/route", { decoderIp: "127.0.1.21", encoderIp: "127.0.2.14" });
  check("space B user cannot route the local source", r.status === 403, r.json);
  r = await admin("POST", "/api/route", { decoderIp: "127.0.1.21", encoderIp: "127.0.2.14" });
  check("even an admin cannot put it on a screen in another space", r.status === 403, r.json);
  r = await a("POST", "/api/route", { decoderIp: "127.0.1.11", encoderIp: "127.0.2.14" });
  check("space A user is allowed to route it on a space A screen", r.status !== 403, r.json);

  r = await admin("DELETE", "/api/admin/devices/spaces/" + encodeURIComponent("Space A"));
  check("a space with screens or local sources cannot be deleted", r.status === 400, r.json);

  r = await admin("POST", "/api/admin/devices/spaces/rename", { from: "Space A", to: "Room A" });
  check("renaming a space renames its local sources", r.status === 200, r.json);
  r = await admin("GET", "/api/admin/devices");
  const sp = r.json.encoders.find((e) => e.ip === "127.0.2.14");
  check("local source follows the rename", sp && sp.space === "Room A", sp);

  console.log(`
${pass} passed, ${fail} failed`);
  child.kill();
  setTimeout(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }, 500);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
