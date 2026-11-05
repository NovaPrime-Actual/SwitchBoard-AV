// AGPL switch: the LICENSE text, source notices, About window data (incl. SOURCE_URL), and the new docs.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const app = path.join(__dirname, "..");
const AGPL_SHA256 = "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0"; // the official GNU AGPL v3 text (LF line endings)
const DCO_SHA256 = "f7ac75b443f4ca16b503241344b41aeff9503b0c30bedc2b119551d83cb0fa90"; // the official Developer Certificate of Origin 1.1 text
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-lic-"));
const PORT = 18610;
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(extra).slice(0, 300)}`,
  );
};
const read = (f) => fs.readFileSync(path.join(app, f), "utf8");
const norm = (s) => s.replace(/\r\n/g, "\n");

function start(dir, extra) {
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
        ...extra,
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
            resolve({ status: res.statusCode, json, text: b });
          });
        },
      );
      req.on("error", (e) => resolve({ error: e.code }));
      if (data) req.write(data);
      req.end();
    });
}
async function login(c, out) {
  const pw = /temporary password: (\S+)/.exec(out)[1];
  await c("POST", "/api/login", { username: "admin", password: pw });
  await c("POST", "/api/change-password", {
    currentPassword: pw,
    newPassword: "admin-test-pass-1",
  });
  await c("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
}

(async () => {
  // ---- files
  const lic = norm(read("LICENSE"));
  check(
    "LICENSE is the official AGPL-3.0 text, unchanged",
    sha256(lic) === AGPL_SHA256 &&
      /^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/.test(lic),
    lic.slice(0, 80),
  );
  const srcFiles = fs
    .readdirSync(path.join(app, "src"), { recursive: true })
    .filter((f) => f.endsWith(".js"))
    .map((f) => "src/" + f.replaceAll("\\", "/"));
  for (const f of [
    "server.js",
    ...srcFiles,
    "public/app.js",
    "public/style.css",
    "public/index.html",
    "test/mock-decoders.js",
  ]) {
    check(
      `${f} carries the SPDX notice once`,
      (read(f).match(/SPDX-License-Identifier: AGPL-3\.0-or-later/g) || []).length === 1,
    );
  }
  const srv = read("server.js");
  check(
    "server.js header has the copyright + the standard AGPL notice",
    /Copyright \(c\) 2026 Brett Cupp/.test(srv) &&
      /GNU Affero General Public License as published by the Free Software Foundation/.test(srv) &&
      /WITHOUT ANY WARRANTY/.test(srv),
  );
  const stale = [];
  for (const f of [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "server.js",
    ...srcFiles,
    "public/index.html",
    "public/app.js",
  ]) {
    const t = read(f);
    if (/\bMIT\b/.test(t) && !/changes from MIT to/.test(t) && !/MIT to the GNU/.test(t))
      stale.push(f);
  }
  check(
    "no leftover mention of the MIT license outside the changelog's change note",
    stale.length === 0,
    stale,
  );
  const readme = read("README.md");
  check(
    "README License section names AGPL-3.0-or-later, the summary, the DCO and CONTRIBUTING",
    /AGPL-3\.0-or-later/.test(readme) &&
      /closed, proprietary/.test(readme) &&
      /\]\(DCO\)/.test(readme) &&
      /\]\(CONTRIBUTING\.md\)/.test(readme) &&
      /SOURCE_URL/.test(readme) &&
      !/CLA/.test(readme),
  );
  const dco = norm(read("DCO"));
  check(
    "DCO is the official Developer Certificate of Origin 1.1 text, unchanged",
    sha256(dco) === DCO_SHA256 &&
      /^Developer Certificate of Origin\s+Version 1\.1/.test(dco) &&
      ["(a) ", "(b) ", "(c) ", "(d) "].every((p) => dco.includes(p)),
    dco.slice(0, 60),
  );
  check("the CLA is gone", !fs.existsSync(path.join(app, "CLA.md")));
  const contrib = read("CONTRIBUTING.md");
  check(
    "CONTRIBUTING explains the sign-off line, git commit -s, the fix-up commands, and the employer note",
    /Signed-off-by: Your Name <you@example\.com>/.test(contrib) &&
      /git commit -s/.test(contrib) &&
      /git commit --amend -s/.test(contrib) &&
      /git rebase --signoff/.test(contrib) &&
      /employer/.test(contrib),
  );
  check(
    "CONTRIBUTING links DCO and LICENSE, says contributors keep copyright, and no longer mentions a CLA",
    /\]\(DCO\)/.test(contrib) &&
      /\]\(LICENSE\)/.test(contrib) &&
      /keep the copyright/.test(contrib) &&
      !/\bCLA\b|Contributor License/.test(contrib),
  );
  const dcoCfg = read(".github/dco.yml");
  check(
    ".github/dco.yml lets people fix a missing sign-off and skips the owner's signed commits",
    /allowRemediationCommits:\s*\n\s*individual: true/.test(dcoCfg) &&
      /require:\s*\n\s*members: false/.test(dcoCfg),
  );
  check(
    "every relative link in the new docs points at a file that exists",
    [
      ...(contrib + readme).matchAll(
        /\]\(([A-Za-z0-9_.-]+\.(?:md|json)|LICENSE|DCO)(?:#[^)]*)?\)/g,
      ),
    ].every((m) => fs.existsSync(path.join(app, m[1]))),
    "",
  );

  // ---- About window data
  const dir = path.join(tmp, "d");
  let s = await start(dir);
  const c = client();
  await login(c, s.out());
  let r = await c("GET", "/api/about");
  check(
    "About: AGPL id + full name + copyright, the source link points at the project by default",
    r.json.licenseId === "AGPL-3.0-or-later" &&
      /Affero General Public License, version 3 or later/.test(r.json.license) &&
      /Brett Cupp/.test(r.json.copyright) &&
      r.json.sourceUrl === "https://github.com/NovaPrime-Actual/SwitchBoard-AV",
    r.json,
  );
  const page = await client()("GET", "/");
  const pageText = page.text.replace(/\s+/g, " "); // the formatter wraps long paragraphs
  check(
    "About window text: license, no-warranty line, LICENSE file pointer, hidden source line",
    /id="aboutLicense"/.test(pageText) &&
      /ABSOLUTELY NO WARRANTY/.test(pageText) &&
      /LICENSE file/.test(pageText) &&
      /id="aboutSource"/.test(pageText),
  );
  await stop(s);

  s = await start(dir, { SOURCE_URL: "https://example.org/switchboard-av" });
  const c2 = client();
  await c2("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
  r = await c2("GET", "/api/about");
  check(
    "SOURCE_URL shows up in About",
    r.json.sourceUrl === "https://example.org/switchboard-av",
    r.json,
  );
  await stop(s);

  for (const bad of [
    "javascript:alert(1)",
    "ftp://example.org/x",
    'https://example.org/"onmouseover="x',
    "example.org",
    "https://exa mple.org",
  ]) {
    s = await start(dir, { SOURCE_URL: bad });
    const c3 = client();
    await c3("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
    r = await c3("GET", "/api/about");
    check(
      `SOURCE_URL "${bad}" is ignored (the project's own address is shown)`,
      r.json.sourceUrl === "https://github.com/NovaPrime-Actual/SwitchBoard-AV",
      r.json,
    );
    await stop(s);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
