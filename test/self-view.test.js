// The signed-in person's own record carries the NAMES of their groups (for the menu's "Signed in as" block).
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-who-"));
const PORT = 18520;
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
  await admin("POST", "/api/change-password", {
    currentPassword: pw,
    newPassword: "admin-test-pass-1",
  });
  let r = await admin("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
  check(
    "login reply carries groupNames (admin, none)",
    r.status === 200 &&
      Array.isArray(r.json.groupNames) &&
      r.json.groupNames.length === 0 &&
      r.json.role === "admin",
    r.json,
  );
  r = await admin("GET", "/api/me");
  check(
    "/api/me carries groupNames for admin",
    Array.isArray(r.json.groupNames) && r.json.groupNames.length === 0,
    r.json,
  );

  const g1 = (
    await admin("POST", "/api/admin/groups", {
      name: "Front Office",
      spaces: ["Space A"],
      sources: "all",
    })
  ).json;
  const g2 = (
    await admin("POST", "/api/admin/groups", {
      name: "Library",
      spaces: ["Space B"],
      sources: "all",
    })
  ).json;
  const made = (
    await admin("POST", "/api/admin/users", {
      name: "Pat Teacher",
      username: "pat",
      role: "user",
      groups: [g1.id, g2.id],
    })
  ).json;
  const pat = client();
  await pat("POST", "/api/login", { username: "pat", password: made.tempPassword });
  await pat("POST", "/api/change-password", {
    currentPassword: made.tempPassword,
    newPassword: "pat-test-pass-1",
  });
  r = await pat("POST", "/api/login", { username: "pat", password: "pat-test-pass-1" });
  check(
    "login reply lists the person's group names",
    r.json &&
      r.json.groupNames.length === 2 &&
      r.json.groupNames.includes("Front Office") &&
      r.json.groupNames.includes("Library"),
    r.json,
  );
  r = await pat("GET", "/api/me");
  check(
    "/api/me lists the same names",
    r.json.groupNames.includes("Front Office") &&
      r.json.groupNames.includes("Library") &&
      r.json.username === "pat" &&
      r.json.name === "Pat Teacher" &&
      r.json.role === "user",
    r.json,
  );
  check(
    "only names, no group ids or other groups leak into the record",
    !JSON.stringify(r.json.groupNames).includes(g1.id) && r.json.groupNames.length === 2,
  );

  // a rename is picked up on the next read
  await admin("PATCH", `/api/admin/groups/${g1.id}`, {
    name: "Main Office",
    spaces: ["Space A"],
    sources: "all",
  });
  r = await pat("GET", "/api/me");
  check(
    "renaming a group shows up immediately",
    r.json.groupNames.includes("Main Office") && !r.json.groupNames.includes("Front Office"),
    r.json,
  );

  // a deleted group simply drops out
  await admin("DELETE", `/api/admin/groups/${g2.id}`);
  r = await pat("GET", "/api/me");
  check(
    "a deleted group drops out of the list",
    JSON.stringify(r.json.groupNames) === '["Main Office"]',
    r.json,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  child.kill();
  setTimeout(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }, 500);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
