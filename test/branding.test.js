// Branding (name / logo / colour) checks. Server runs with TLS=off; each process stopped by its own handle.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-brand-"));
const PORT = 18460;
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300)}`,
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
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        resolve({ child, out: () => out });
      }
    };
    child.stdout.on("data", (d) => {
      out += d;
      if (/Open http/.test(out)) fin();
    });
    child.stderr.on("data", (d) => (out += d));
    setTimeout(fin, 8000);
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
      const data =
        body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
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
          const chunks = [];
          res.on("data", (d) => chunks.push(d));
          res.on("end", () => {
            const sc = res.headers["set-cookie"];
            if (sc) cookie = sc.map((c) => c.split(";")[0]).join("; ");
            const buf = Buffer.concat(chunks);
            let json;
            try {
              json = JSON.parse(buf.toString("utf8"));
            } catch {
              json = null; // the body is not JSON
            }
            resolve({
              status: res.statusCode,
              json,
              text: buf.toString("utf8"),
              buf,
              headers: res.headers,
            });
          });
        },
      );
      req.on("error", (e) => resolve({ error: e.code || e.message }));
      if (data) req.write(data);
      req.end();
    });
}
async function login(c, out) {
  const tmpPw = /temporary password: (\S+)/.exec(out)[1];
  await c("POST", "/api/login", { username: "admin", password: tmpPw });
  await c("POST", "/api/change-password", {
    currentPassword: tmpPw,
    newPassword: "admin-test-pass-1",
  });
  return (
    (await c("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" })).status ===
    200
  );
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40, 1)]);
const webp = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x20, 0, 0, 0]),
  Buffer.from("WEBP"),
  Buffer.alloc(40, 1),
]);
const b64 = (b) => b.toString("base64");
const good = { appName: "AV Control", orgName: "Example School", accent: "#59606b" };

(async () => {
  const dir = path.join(tmp, "d");
  let s = await start(dir);
  const anon = client();

  // ---- public bits, signed out
  let r = await anon("GET", "/");
  check(
    "sign-in page: the default name and no leftover placeholders",
    r.status === 200 && /<title>SwitchBoard-AV<\/title>/.test(r.text) && !/\{\{/.test(r.text),
    r.text.slice(0, 300),
  );
  check(
    "sign-in page: no organization line text when none is set",
    /<div class="sub"><\/div>/.test(r.text),
  );
  r = await anon("GET", "/branding.css");
  check(
    "signed-out /branding.css gives only the two colour variables",
    r.status === 200 &&
      /^text\/css/.test(r.headers["content-type"]) &&
      /--accent: #59606b/.test(r.text) &&
      /--accent-tint: #[0-9a-f]{6}/.test(r.text) &&
      r.text.split("\n").length <= 8 &&
      /--select: #a6171d/.test(r.text) &&
      /--select-tint: #[0-9a-f]{6}/.test(r.text) &&
      r.headers["cache-control"] === "no-cache",
    r.text,
  );
  r = await anon("GET", "/branding/logo");
  check(
    "signed-out default logo is served (PNG)",
    r.status === 200 &&
      /image\/png/.test(r.headers["content-type"]) &&
      r.headers["x-content-type-options"] === "nosniff" &&
      /sandbox/.test(r.headers["content-security-policy"]),
    r.headers,
  );
  r = await anon("GET", "/api/admin/branding");
  check("signed-out admin branding is refused", r.status === 401, r.status);

  const c = client();
  check("admin login", await login(c, s.out()));
  r = await c("GET", "/api/admin/branding");
  check(
    "admin reads defaults",
    r.json &&
      r.json.appName === "SwitchBoard-AV" &&
      r.json.orgName === "" &&
      r.json.accent === "#59606b" &&
      r.json.select === "#a6171d" &&
      r.json.hasLogo === false,
    r.json,
  );

  // non-admin
  const cr = await c("POST", "/api/admin/users", {
    name: "Bob",
    username: "bob",
    role: "user",
    groups: [],
  });
  const bob = client();
  await bob("POST", "/api/login", { username: "bob", password: cr.json.tempPassword });
  await bob("POST", "/api/change-password", {
    currentPassword: cr.json.tempPassword,
    newPassword: "bob-test-pass-1",
  });
  await bob("POST", "/api/login", { username: "bob", password: "bob-test-pass-1" });
  const a1 = await bob("GET", "/api/admin/branding");
  const a2 = await bob("POST", "/api/admin/branding", good);
  const a3 = await bob("POST", "/api/admin/branding/reset", {});
  check(
    "non-admin cannot read, change or reset branding",
    a1.status === 403 && a2.status === 403 && a3.status === 403,
    [a1.status, a2.status, a3.status],
  );

  // ---- save valid settings
  r = await c("POST", "/api/admin/branding", { ...good, accent: "#482D8C" });
  check(
    "save works; colour lower-cased",
    r.status === 200 &&
      r.json.accent === "#482d8c" &&
      r.json.appName === "AV Control" &&
      r.json.orgName === "Example School",
    r.json,
  );
  r = await anon("GET", "/");
  check(
    "page now carries the new name, org, alt text",
    /<title>AV Control<\/title>/.test(r.text) &&
      /<h1>AV Control<\/h1>/.test(r.text) &&
      /<div class="sub">Example School<\/div>/.test(r.text) &&
      /alt="Example School"/.test(r.text),
    r.text.slice(0, 600),
  );
  r = await anon("GET", "/branding.css");
  check(
    "css carries the new colour and a lighter tint",
    /--accent: #482d8c/.test(r.text) &&
      /--accent-tint: #[0-9a-f]{6}/.test(r.text) &&
      !/--accent-tint: #482d8c/.test(r.text),
    r.text,
  );

  // ---- About window data
  r = await anon("GET", "/api/about");
  check("About needs a sign-in", r.status === 401, r.status);
  r = await bob("GET", "/api/about");
  const headerVersion = (/SWITCHBOARD-AV\s+v(\S+)/.exec(
    fs.readFileSync(path.join(app, "server.js"), "utf8"),
  ) || [])[1];
  check(
    "any signed-in user can read About: app name, version, license, copyright",
    r.status === 200 &&
      r.json.appName === "AV Control" &&
      r.json.version === headerVersion &&
      r.json.licenseId === "AGPL-3.0-or-later" &&
      /Affero/.test(r.json.license) &&
      /Brett Cupp/.test(r.json.copyright) &&
      r.json.sourceUrl === "https://github.com/NovaPrime-Actual/SwitchBoard-AV",
    r.json,
  );
  const idx = await anon("GET", "/");
  check(
    "About menu item and window are on the page",
    /id="aboutBtn"/.test(idx.text) && /id="aboutBackdrop"/.test(idx.text),
  );

  // ---- highlight (select) colour
  r = await c("POST", "/api/admin/branding", { ...good, select: "#1f7a4d" });
  check(
    "highlight colour saved; header colour untouched",
    r.status === 200 && r.json.select === "#1f7a4d" && r.json.accent === "#59606b",
    r.json,
  );
  r = await anon("GET", "/branding.css");
  check(
    "css carries the highlight and its own tint",
    /--select: #1f7a4d/.test(r.text) &&
      /--select-tint: #[0-9a-f]{6}/.test(r.text) &&
      /--accent: #59606b/.test(r.text),
    r.text,
  );
  r = await c("POST", "/api/admin/branding", { ...good });
  check(
    "a save that leaves select out keeps the current highlight",
    r.status === 200 && r.json.select === "#1f7a4d",
    r.json,
  );
  for (const [label, val, re] of [
    ["CSS injection", "#fff;}body{display:none", /Highlight colour: .*must look like/],
    ["too light", "#ffffff", /Highlight colour: .*too light/],
    ["too dark", "#000000", /Highlight colour: .*too dark/],
    ["empty", "", /Highlight colour/],
  ]) {
    r = await c("POST", "/api/admin/branding", { ...good, select: val });
    check("highlight colour refused: " + label, r.status === 400 && re.test(r.json.error), r.json);
  }
  r = await anon("GET", "/branding.css");
  check(
    "refused highlight colours never reached the css",
    /--select: #1f7a4d/.test(r.text) && !/display:none/.test(r.text),
  );
  r = await c("POST", "/api/admin/branding", { ...good, select: "#A6171D" });
  check("highlight colour is lower-cased", r.json && r.json.select === "#a6171d", r.json);
  r = await c("GET", "/api/admin/activity");
  check(
    "activity log names the highlight colour change",
    r.json.some((e) => e.type === "branding_update" && /highlight colour #1f7a4d/.test(e.detail)),
    r.json.slice(0, 5),
  );

  // ---- hostile / bad text
  r = await c("POST", "/api/admin/branding", {
    ...good,
    appName: "<script>alert(1)</script>",
    orgName: "A&B \"Co\" 'x'",
  });
  check("markup in names is accepted as text...", r.status === 200, r.json);
  r = await anon("GET", "/");
  check(
    "...but is HTML-escaped everywhere it is placed",
    !/<script>alert/.test(r.text) &&
      /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(r.text) &&
      /A&amp;B &quot;Co&quot; &#39;x&#39;/.test(r.text),
    r.text.slice(0, 700),
  );
  r = await c("POST", "/api/admin/branding", { ...good, appName: "" });
  check("empty app name refused", r.status === 400 && /cannot be empty/.test(r.json.error), r.json);
  r = await c("POST", "/api/admin/branding", { ...good, appName: "x".repeat(41) });
  check("overlong app name refused", r.status === 400, r.json);
  r = await c("POST", "/api/admin/branding", { ...good, orgName: "x".repeat(81) });
  check("overlong organization refused", r.status === 400, r.json);
  r = await c("POST", "/api/admin/branding", { ...good, appName: "two\nlines" });
  check("line breaks refused", r.status === 400, r.json);

  // ---- colours
  for (const [label, val, re] of [
    ["CSS injection", "#fff;}body{display:none", /must look like/],
    ["too light (white)", "#ffffff", /too light/],
    ["too light (yellow)", "#ffee00", /too light/],
    ["too dark (black)", "#000000", /too dark/],
    ["not hex", "red", /must look like/],
    ["short hex", "#abc", /must look like/],
    ["empty", "", /must look like/],
  ]) {
    r = await c("POST", "/api/admin/branding", { ...good, accent: val });
    check(`colour refused: ${label}`, r.status === 400 && re.test(r.json.error), r.json);
  }
  r = await anon("GET", "/branding.css");
  check("css never contained the injected text", !/display:none/.test(r.text));

  // ---- logos
  r = await c("POST", "/api/admin/branding", { ...good, logo: { data: b64(png) } });
  check(
    "PNG logo accepted",
    r.status === 200 && r.json.hasLogo && /v=\d+/.test(r.json.logoUrl),
    r.json,
  );
  const v1 = r.json.logoUrl;
  r = await anon("GET", "/branding/logo");
  check(
    "served as the right type, nosniff, sandboxed, same bytes",
    r.status === 200 &&
      r.headers["content-type"] === "image/png" &&
      r.headers["x-content-type-options"] === "nosniff" &&
      /sandbox/.test(r.headers["content-security-policy"]) &&
      r.buf.equals(png),
    r.headers,
  );
  r = await anon("GET", "/");
  check(
    "page points at the versioned logo URL",
    r.text.includes(`src="${v1}"`),
    r.text.slice(0, 500),
  );
  await new Promise((x) => setTimeout(x, 15));
  r = await c("POST", "/api/admin/branding", { ...good, logo: { data: b64(jpg) } });
  check(
    "JPEG accepted, replaces PNG, new version in URL",
    r.status === 200 && r.json.logoUrl !== v1,
    r.json,
  );
  check(
    "only one logo file kept",
    fs.readdirSync(path.join(dir, "branding")).filter((f) => f.startsWith("logo.")).length === 1,
    fs.readdirSync(path.join(dir, "branding")),
  );
  r = await anon("GET", "/branding/logo");
  check("JPEG served as image/jpeg", r.headers["content-type"] === "image/jpeg");
  r = await c("POST", "/api/admin/branding", { ...good, logo: { data: b64(gif) } });
  check("GIF accepted", r.status === 200, r.json);
  r = await c("POST", "/api/admin/branding", { ...good, logo: { data: b64(webp) } });
  check("WebP accepted", r.status === 200, r.json);
  const before = (await anon("GET", "/branding/logo")).buf;
  for (const [label, data, re] of [
    [
      "HTML renamed to .png",
      Buffer.from("<html><script>alert(1)</script></html>"),
      /PNG, JPEG, GIF or WebP/,
    ],
    [
      "SVG",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      /SVG/,
    ],
    ["text file", Buffer.from("hello world"), /PNG, JPEG, GIF or WebP/],
    ["PNG header too short", Buffer.from([0x89, 0x50, 0x4e, 0x47]), /PNG, JPEG, GIF or WebP/],
  ]) {
    r = await c("POST", "/api/admin/branding", { ...good, logo: { data: b64(data) } });
    check(`logo refused: ${label}`, r.status === 400 && re.test(r.json.error), r.json);
  }
  r = await c("POST", "/api/admin/branding", { ...good, logo: { data: "!!not base64!!" } });
  check("logo refused: not base64", r.status === 400, r.json);
  r = await c("POST", "/api/admin/branding", {
    ...good,
    logo: { data: b64(Buffer.concat([png, Buffer.alloc(520 * 1024)])) },
  });
  check(
    "oversized logo -> clean 400",
    r.status === 400 && /too large/.test(r.json.error),
    r.status + JSON.stringify(r.json),
  );
  r = await c("POST", "/api/admin/branding", { ...good, logo: { data: "A".repeat(900000) } });
  check(
    "huge body -> clean 400, not a dropped connection",
    r.status === 400 && /too large/.test(r.json.error),
    r.status + " " + (r.error || ""),
  );
  check(
    "refused uploads left the logo untouched",
    (await anon("GET", "/branding/logo")).buf.equals(before),
  );

  // ---- remove logo, persistence, reset
  r = await c("POST", "/api/admin/branding", { ...good, removeLogo: true });
  check(
    "remove logo -> default icon again",
    r.status === 200 &&
      r.json.hasLogo === false &&
      /png/.test((await anon("GET", "/branding/logo")).headers["content-type"]),
  );
  await c("POST", "/api/admin/branding", { ...good, accent: "#2a7a3b", logo: { data: b64(png) } });
  await stop(s);
  s = await start(dir);
  const c2 = client();
  await c2("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
  r = await c2("GET", "/api/admin/branding");
  check(
    "branding survives a restart",
    r.json &&
      r.json.appName === "AV Control" &&
      r.json.orgName === "Example School" &&
      r.json.accent === "#2a7a3b" &&
      r.json.select === "#a6171d" &&
      r.json.hasLogo,
    r.json,
  );
  check("...logo bytes too", (await client()("GET", "/branding/logo")).buf.equals(png));
  r = await c2("GET", "/api/admin/activity");
  check(
    "activity log records branding changes with who",
    r.json.some((e) => e.type === "branding_update" && e.by === "admin" && /logo/.test(e.detail)) &&
      r.json.some((e) => e.type === "branding_update" && /colour #2a7a3b/.test(e.detail)),
    r.json.slice(0, 4),
  );
  r = await c2("POST", "/api/admin/branding/reset", {});
  check(
    "reset restores every default",
    r.status === 200 &&
      r.json.appName === "SwitchBoard-AV" &&
      r.json.orgName === "" &&
      r.json.accent === "#59606b" &&
      !r.json.hasLogo &&
      !fs.existsSync(path.join(dir, "branding.json")) &&
      fs.readdirSync(path.join(dir, "branding")).filter((f) => f.startsWith("logo.")).length === 0,
    r.json,
  );
  r = await c2("GET", "/api/admin/activity");
  check(
    "reset is logged",
    r.json.some((e) => e.type === "branding_reset" && e.by === "admin"),
  );
  await stop(s);

  // ---- damaged branding.json must not stop the app
  fs.writeFileSync(
    path.join(dir, "branding.json"),
    '{"appName": 5, "accent": "red; x", "logoExt": "svg"}',
  );
  s = await start(dir);
  r = await client()("GET", "/branding.css");
  check(
    "garbage branding.json -> safe defaults, app still starts",
    r.status === 200 && /--accent: #59606b/.test(r.text),
    r.text,
  );
  await stop(s);

  // ---- nothing organization-specific left in the code
  const srcFiles = fs
    .readdirSync(path.join(app, "src"), { recursive: true })
    .filter((f) => f.endsWith(".js"))
    .map((f) => "src/" + f.replaceAll("\\", "/"));
  const files = [
    "server.js",
    ...srcFiles,
    "public/index.html",
    "public/app.js",
    "public/style.css",
  ];
  const hits = [];
  for (const f of files) {
    const t = fs.readFileSync(path.join(app, f), "utf8");
    for (const re of [/brand-violet/, /brand-grey/, /brand-black/, /482d8c/i])
      if (re.test(t)) hits.push(`${f}: ${re}`);
  }
  check(
    "none of the old built-in brand colours or colour tokens are left in the code",
    hits.length === 0,
    hits,
  );
  check("school logo file is gone from public/", !fs.existsSync(path.join(app, "public/logo.png")));

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
