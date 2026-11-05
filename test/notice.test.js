// Name/logo policy and the section 7 additional terms: files, wording, links, and the fixed credit in About.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-notice-"));
const PORT = 18690;
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300)}`,
  );
};
const read = (f) => fs.readFileSync(path.join(app, f), "utf8").replace(/\r\n/g, "\n");

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
            resolve({ status: res.statusCode, json, text: b });
          });
        },
      );
      req.on("error", (e) => resolve({ error: e.code }));
      if (data) req.write(data);
      req.end();
    });
}

(async () => {
  // ---- files
  const notice = read("NOTICE");
  const license = read("LICENSE").replace(/\s+/g, " "); // the license text is wrapped across lines
  check(
    "NOTICE has the two additional terms, naming sections 7(e) and 7(b)",
    /1\. Trademarks \(section 7\(e\)\)/.test(notice) &&
      /2\. Author attribution \(section 7\(b\)\)/.test(notice),
    notice.slice(0, 200),
  );
  check(
    "the credit is spelled out exactly, with the Based-on allowance",
    /SwitchBoard-AV by Brett Cupp/.test(notice) && /"Based on"/.test(notice),
  );
  check(
    "NOTICE names the logo file and points at TRADEMARKS.md",
    /public\/logo-default\.png/.test(notice) &&
      /TRADEMARKS\.md/.test(notice) &&
      fs.existsSync(path.join(app, "public/logo-default.png")),
  );
  check(
    "both terms are of kinds the AGPL's own section 7 lists (checked against the license text in the repo)",
    /Declining to grant rights under trademark law for use of some trade names, trademarks, or service marks/.test(
      license,
    ) &&
      /Requiring preservation of specified reasonable legal notices or author attributions/.test(
        license,
      ),
  );
  check(
    "NOTICE says it applies to contributions too",
    /including contributions accepted into it/.test(notice),
  );

  const tm = read("TRADEMARKS.md");
  check(
    "TRADEMARKS.md has You may / You may not / If you publish a modified version / Questions",
    ["## You may", "## You may not", "## If you publish a modified version", "## Questions"].every(
      (h) => new RegExp("^" + h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:,.*)?$", "m").test(tm),
    ),
    tm.match(/^## .*/gm),
  );
  check(
    "it lets unmodified installs keep the name/logo, allows truthful references, and allows Branding-only changes",
    /unmodified software/.test(tm) &&
      /based on SwitchBoard-AV/i.test(tm) &&
      /Branding settings/.test(tm),
  );
  check(
    "it forbids calling a modified version SwitchBoard-AV or using the logo for it, and implying endorsement",
    /Call a modified version "SwitchBoard-AV"/.test(tm) &&
      /Suggest that the project made, approved or supports/.test(tm),
  );
  check(
    "it tells modified versions to rename, keep the credit, and replace the Powered by wording",
    /its own name and its own logo/.test(tm) &&
      /SwitchBoard-AV by Brett Cupp/.test(tm) &&
      /Powered by\s+SwitchBoard-AV/.test(tm) &&
      /Based on SwitchBoard-AV/.test(tm),
  );
  check(
    "it explains that a modified version means changed code, not Branding settings",
    /not one where only the Branding settings were used/.test(tm),
  );

  // ---- references
  const readme = read("README.md"),
    contrib = read("CONTRIBUTING.md"),
    srv = read("server.js"),
    change = read("CHANGELOG.md");
  check(
    "README links NOTICE and TRADEMARKS.md and summarises the rule",
    /\]\(NOTICE\)/.test(readme) &&
      /\]\(TRADEMARKS\.md\)/.test(readme) &&
      /modified version/.test(readme) &&
      /SwitchBoard-AV by Brett Cupp/.test(readme),
  );
  check(
    "CONTRIBUTING says contributions are under the same license and the NOTICE terms",
    /\]\(NOTICE\)/.test(contrib) &&
      /\]\(TRADEMARKS\.md\)/.test(contrib) &&
      /those terms/.test(contrib),
  );
  check(
    "server.js header points to NOTICE and TRADEMARKS.md",
    /Additional terms under section 7/.test(srv) && /NOTICE file and TRADEMARKS\.md/.test(srv),
  );
  check(
    "changelog mentions the policy and both terms",
    /TRADEMARKS\.md/.test(change) && /7\(e\)/.test(change) && /7\(b\)/.test(change),
  );
  check(
    "every relative link in the license docs points at a file that exists",
    [
      ...(readme + contrib + tm).matchAll(
        /\]\(([A-Za-z0-9_.-]+\.md|LICENSE|NOTICE|DCO)(?:#[^)]*)?\)/g,
      ),
    ].every((m) => fs.existsSync(path.join(app, m[1]))),
    "",
  );

  // ---- About window: the credit is fixed text
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
  const anon = client();
  let r = await anon("GET", "/");
  check(
    "About window: fixed 'by Brett Cupp' under the version",
    /<div class="about-name">SwitchBoard-AV<\/div>[\s\S]*?id="aboutVersion"[\s\S]*?<div class="about-version">by Brett Cupp<\/div>/.test(
      r.text,
    ),
  );
  const admin = client();
  const pw = /temporary password: (\S+)/.exec(out)[1];
  await admin("POST", "/api/login", { username: "admin", password: pw });
  await admin("POST", "/api/change-password", {
    currentPassword: pw,
    newPassword: "sunny classroom projector",
  });
  await admin("POST", "/api/login", { username: "admin", password: "sunny classroom projector" });
  await admin("POST", "/api/admin/branding", {
    appName: "Maple School AV",
    orgName: "Maple",
    accent: "#59606b",
    credit: "by Somebody Else",
  });
  r = await anon("GET", "/");
  check(
    "renaming the install and sending a 'credit' field to Branding changes nothing in the credit",
    /<div class="about-version">by Brett Cupp<\/div>/.test(r.text) && !/Somebody Else/.test(r.text),
  );
  r = await admin("GET", "/api/admin/branding");
  check(
    "the Branding settings have no field for the credit",
    !Object.keys(r.json).some((k) => /credit|author|by/i.test(k) && k !== "defaults"),
    Object.keys(r.json),
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
