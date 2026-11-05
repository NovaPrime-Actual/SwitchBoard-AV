// The fixed "Powered by SwitchBoard-AV" wording: always on the login card, the main page and in About,
// whatever is set in Branding.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-pb-"));
const PORT = 18650;
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
            resolve({ status: res.statusCode, json, text: b });
          });
        },
      );
      req.on("error", (e) => resolve({ error: e.code }));
      if (data) req.write(data);
      req.end();
    });
}

const fixed = /Powered by <strong>SwitchBoard-AV<\/strong>/g;

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

  const anon = client();
  let r = await anon("GET", "/");
  check(
    "default page: the fixed wording is on the login card and the main page (twice in the HTML)",
    (r.text.match(fixed) || []).length === 2,
    (r.text.match(fixed) || []).length,
  );
  check(
    "About shows the fixed program name, not a placeholder",
    /<div class="about-name">SwitchBoard-AV<\/div>/.test(r.text) && !/\{\{/.test(r.text),
  );

  const admin = client();
  const pw = /temporary password: (\S+)/.exec(out)[1];
  await admin("POST", "/api/login", { username: "admin", password: pw });
  await admin("POST", "/api/change-password", {
    currentPassword: pw,
    newPassword: "sunny classroom projector",
  });
  await admin("POST", "/api/login", { username: "admin", password: "sunny classroom projector" });

  for (const name of ["Maple School AV", "Powered by Someone Else", "<b>SwitchBoard</b>", "AV"]) {
    r = await admin("POST", "/api/admin/branding", {
      appName: name,
      orgName: "Maple School",
      accent: "#59606b",
    });
    check(`renamed to "${name}": saved`, r.status === 200, r.json);
    r = await anon("GET", "/");
    check(
      `  ...the page still says "Powered by SwitchBoard-AV" in both places, and the About name is unchanged`,
      (r.text.match(fixed) || []).length === 2 &&
        /<div class="about-name">SwitchBoard-AV<\/div>/.test(r.text),
      (r.text.match(fixed) || []).length,
    );
    check(
      "  ...and the branded name is only in the title/headings, escaped",
      !/<b>SwitchBoard<\/b>/.test(r.text),
    );
  }

  // the Branding API has no way to change it, whatever is sent
  await admin("POST", "/api/admin/branding", {
    appName: "Maple School AV",
    orgName: "",
    accent: "#59606b",
    poweredBy: "Powered by Nobody",
    poweredByHtml: "<i>x</i>",
  });
  r = await anon("GET", "/");
  check(
    "extra fields sent to the Branding API (poweredBy...) change nothing",
    (r.text.match(fixed) || []).length === 2 && !/Nobody/.test(r.text) && !/<i>x<\/i>/.test(r.text),
  );
  r = await admin("GET", "/api/admin/branding");
  check(
    "the Branding settings have no field for the wording",
    !Object.keys(r.json).some((k) => /powered/i.test(k)),
    Object.keys(r.json),
  );

  // the source files: the wording is literal text in the page, not read from settings
  const html = fs.readFileSync(path.join(app, "public/index.html"), "utf8");
  check(
    "in index.html it is literal text next to a note that it is not part of Branding",
    (html.match(/Powered by <strong>SwitchBoard-AV<\/strong>/g) || []).length === 2 &&
      /not part of the Branding settings/.test(html),
  );
  const css = fs.readFileSync(path.join(app, "public/style.css"), "utf8");
  check(
    "the corner wording is positioned so it stays visible and does not capture clicks",
    /\.powered-by-fixed\s*\{[^}]*position:\s*fixed/.test(css) && /pointer-events:\s*none/.test(css),
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
