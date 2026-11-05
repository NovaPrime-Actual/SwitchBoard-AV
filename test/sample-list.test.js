// SPDX-License-Identifier: AGPL-3.0-or-later
// The devices.json that comes with the app: a first start with no settings imports it, and the app comes up with it.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-av-test-sample-"));
const PORT = 18700;
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300)}`,
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
            ...(cookie ? { cookie } : {}),
            "content-type": "application/json",
            ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
          },
        },
        (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => {
            const sc = res.headers["set-cookie"];
            if (sc) cookie = sc.map((x) => x.split(";")[0]).join("; ");
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
  // no DEVICES_FILE and no PORT: the app uses the devices.json next to server.js, as a new install does
  const env = {
    ...process.env,
    DATA_DIR: path.join(tmp, "data"),
    TLS: "off",
    STATUS_POLL_SECONDS: "0",
    BIND: "127.0.0.1",
  };
  delete env.DEVICES_FILE;
  env.PORT = String(PORT); // keep the test off the usual port; settings.json is checked separately below
  const child = spawn(process.execPath, [path.join(APP, "server.js")], {
    cwd: APP,
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

  check(
    "a first start with the shipped devices.json comes up and says what it imported",
    /Open http/.test(out) && /imported 6 screens and 3 sources from devices\.json/.test(out),
    out.slice(-400),
  );
  check("it makes no warnings about the device list", !/WARNING/.test(out), out);

  const admin = client();
  const pw = /temporary password: (\S+)/.exec(out)[1];
  await admin("POST", "/api/login", { username: "admin", password: pw });
  await admin("POST", "/api/change-password", {
    currentPassword: pw,
    newPassword: "sunny classroom projector",
  });
  await admin("POST", "/api/login", { username: "admin", password: "sunny classroom projector" });

  const r = await admin("GET", "/api/admin/devices");
  const d = r.json || {};
  check(
    "the app holds 6 screens and 3 sources, marked as imported",
    d.decoders && d.decoders.length === 6 && d.encoders.length === 3 && d.source === "imported",
    [d.decoders && d.decoders.length, d.encoders && d.encoders.length, d.source],
  );
  check(
    "the four spaces of the sample are listed",
    JSON.stringify(d.spaces) === JSON.stringify(["Library", "Gym", "Cafeteria", "Offices"]),
    d.spaces,
  );
  check(
    "two screens have LG TV power, and one source offers input switching",
    d.decoders.filter((x) => x.tvPower === "lg").length === 2 &&
      d.encoders.filter((x) => Array.isArray(x.inputs) && x.inputs.length === 4).length === 1,
  );
  check(
    "every address is in a documentation-only range, so nothing real can be reached",
    [...d.decoders, ...d.encoders].every((x) =>
      /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(x.ip),
    ),
  );

  const settings = JSON.parse(fs.readFileSync(path.join(tmp, "data", "settings.json"), "utf8"));
  check(
    "the ports in devices.json were copied into data/settings.json",
    settings.port === 8080 && settings.decoderPort === 8000,
    settings,
  );
  const snap = await admin("GET", "/api/devices");
  check(
    "the admin sees all six screens and three sources on the main page",
    snap.json.decoders.length === 6 && snap.json.sources.length === 3,
    [snap.json.decoders && snap.json.decoders.length],
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
