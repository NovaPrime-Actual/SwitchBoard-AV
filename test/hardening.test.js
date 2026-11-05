// Hardening pass: security headers, session expiry, background refreshes, session rotation, password rules,
// cross-site refusals, per-address sign-in limit, paste-import size.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-hard-"));
const PORT = 18630;
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300)}`,
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(app, f), "utf8");

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

// a browser-like client with its own cookie jar; extra headers per call
function client() {
  let cookie = "";
  const c = (method, url, body, headers = {}) =>
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
            ...(cookie ? { cookie } : {}),
            "content-type": "application/json",
            ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (d) => chunks.push(d));
          res.on("end", () => {
            const sc = res.headers["set-cookie"];
            if (sc) cookie = sc.map((x) => x.split(";")[0]).join("; ");
            const text = Buffer.concat(chunks).toString("utf8");
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              json = null; // the body is not JSON
            }
            resolve({ status: res.statusCode, json, text, headers: res.headers });
          });
        },
      );
      req.on("error", (e) => resolve({ error: e.code }));
      if (data) req.write(data);
      req.end();
    });
  c.cookie = () => cookie;
  c.setCookie = (v) => {
    cookie = v;
  };
  return c;
}
async function firstLogin(c, out, newPw) {
  const pw = /temporary password: (\S+)/.exec(out)[1];
  await c("POST", "/api/login", { username: "admin", password: pw });
  const r = await c("POST", "/api/change-password", { currentPassword: pw, newPassword: newPw });
  await c("POST", "/api/login", { username: "admin", password: newPw });
  return { tempPw: pw, changed: r };
}
const GOOD = "correct horse battery staple";

(async () => {
  // ================= A: default settings
  const dirA = path.join(tmp, "a");
  let s = await start(dirA, {});
  const anon = client();

  // ---- headers
  let r = await anon("GET", "/");
  const h = r.headers;
  const csp = h["content-security-policy"] || "";
  check(
    "page: Content-Security-Policy locks scripts/styles/frames/base/forms to this site",
    /default-src 'self'/.test(csp) &&
      /script-src 'self'/.test(csp) &&
      /style-src 'self'/.test(csp) &&
      /frame-ancestors 'none'/.test(csp) &&
      /object-src 'none'/.test(csp) &&
      /base-uri 'none'/.test(csp) &&
      /form-action 'self'/.test(csp) &&
      !/unsafe-inline|unsafe-eval/.test(csp),
    csp,
  );
  check(
    "page: nosniff, DENY framing, no referrer, permissions policy, same-origin COOP/CORP",
    h["x-content-type-options"] === "nosniff" &&
      h["x-frame-options"] === "DENY" &&
      h["referrer-policy"] === "no-referrer" &&
      /camera=\(\)/.test(h["permissions-policy"] || "") &&
      h["cross-origin-opener-policy"] === "same-origin" &&
      h["cross-origin-resource-policy"] === "same-origin",
    h,
  );
  check(
    "page: re-checked each time (no-cache), no HSTS by default, no X-Powered-By",
    h["cache-control"] === "no-cache" && !h["strict-transport-security"] && !h["x-powered-by"],
    h,
  );
  for (const p of ["/app.js", "/style.css", "/branding.css", "/branding/logo", "/nope.txt"]) {
    r = await anon("GET", p);
    check(
      `${p}: same protective headers (status ${r.status})`,
      (r.headers["x-content-type-options"] === "nosniff" &&
        /frame-ancestors 'none'/.test(
          r.headers["content-security-policy"] || r.headers["content-security-policy"] || "",
        )) ||
        (p === "/branding/logo" && /sandbox/.test(r.headers["content-security-policy"])),
      r.headers,
    );
  }
  r = await anon("GET", "/api/me");
  check(
    "API: 401 is never cached, carries the headers, and says signedOut",
    r.status === 401 &&
      r.headers["cache-control"] === "no-store" &&
      r.headers["x-frame-options"] === "DENY" &&
      r.json.signedOut === true &&
      r.json.error === "Not signed in",
    [r.status, r.headers["cache-control"], r.json],
  );

  // ---- the page must work under that policy
  const html = read("public/index.html"),
    js = read("public/app.js");
  check(
    "page has no inline script, no style attributes, no inline event handlers (so the CSP breaks nothing)",
    !/<script(?![^>]*\ssrc=)[^>]*>/i.test(html) &&
      !/\sstyle\s*=/i.test(html) &&
      !/\son[a-z]+\s*=/i.test(html),
    "",
  );
  check(
    "client code never builds HTML or code from text",
    !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\(\s*["']style["']/.test(
      js
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n"),
    ),
    "",
  );

  // ---- sign in, then the password rules
  const admin = client();
  const first = await firstLogin(admin, s.out(), "admin-start-pass-77");
  check(
    "first password change works with a good password",
    first.changed.status === 200,
    first.changed.json,
  );
  const A_PW = "admin-start-pass-77";
  const bads = [
    ["7 characters", "abc1234", /at least 8 characters/],
    ["7 characters with a symbol", "a1!b2@c", /at least 8 characters/],
    ["over 200 characters", "a1b2c3d4e5".repeat(21), /at most 200/],
    ["8 letters and nothing else", "plainold", /number or special character/],
    [
      "a long run of letters and nothing else",
      "purpleelephantsdance",
      /number or special character/,
    ],
    ["digits only", "73194826", /some letters/],
    ["symbols only", "!!!!!!!!", /some letters/],
    ["a common password", "password1", /too common/],
    ["a common password in other case", "Password123", /too common/],
    ["a common password with symbols", "Pass-word-123", /too common/],
    ["another common one", "qwerty123", /too common/],
    ["a common one with a symbol on the end", "iloveyou!", /number or special|too common/],
    ["letters in a row, with a symbol", "abcdefgh!", /too easy/],
    ["one repeated character, with a symbol", "aaaaaaaa!", /too easy/],
    ["just the username", "admin", /at least 8 characters/],
    ["the username twice", "admin-admin-", /just your username/],
    ["the username with decoration", "ADMIN!!!!!!!!", /just your username/],
    ["the same as the current password", A_PW, /different/],
  ];
  for (const [label, pw, re] of bads) {
    r = await admin("POST", "/api/change-password", { currentPassword: A_PW, newPassword: pw });
    check(`password refused: ${label}`, r.status === 400 && re.test(r.json.error), r.json);
  }
  r = await admin("POST", "/api/change-password", {
    currentPassword: "not my password",
    newPassword: "x",
  });
  check(
    "a wrong current password is answered first (401, no hint about the rules, and not a 'signed out')",
    r.status === 401 && /incorrect/.test(r.json.error) && !r.json.signedOut,
    r.json,
  );
  check(
    "a password change that was refused kept the session",
    (await admin("GET", "/api/me")).status === 200,
  );

  // an 8-character password with a letter and a number/symbol is accepted (the minimum is 8 again)
  r = await admin("POST", "/api/change-password", {
    currentPassword: A_PW,
    newPassword: "plain-t8",
  });
  check(
    "an 8-character password with letters and a number/special character is accepted",
    r.status === 200,
    r.json,
  );
  r = await admin("POST", "/api/change-password", {
    currentPassword: "plain-t8",
    newPassword: "Blue7sky",
  });
  check("so is one with only a number as its extra (Blue7sky)", r.status === 200, r.json);
  r = await admin("POST", "/api/change-password", {
    currentPassword: "Blue7sky",
    newPassword: "two words here",
  });
  check("and a passphrase whose only special characters are spaces", r.status === 200, r.json);
  r = await admin("POST", "/api/change-password", {
    currentPassword: "two words here",
    newPassword: A_PW,
  });
  check("back to the long one for the rest of the checks", r.status === 200, r.json);

  // ---- change password signs the person out elsewhere, keeps this session
  const second = client();
  await second("POST", "/api/login", { username: "admin", password: A_PW });
  check("a second sign-in works", (await second("GET", "/api/me")).status === 200);
  r = await admin("POST", "/api/change-password", { currentPassword: A_PW, newPassword: GOOD });
  check("a passphrase of unrelated words is accepted", r.status === 200, r.json);
  check(
    "...the session that changed it stays signed in",
    (await admin("GET", "/api/me")).status === 200,
  );
  r = await second("GET", "/api/me");
  check(
    "...every other session of that person is ended",
    r.status === 401 && r.json.signedOut === true,
    r.json,
  );
  r = await client()("POST", "/api/login", { username: "admin", password: A_PW });
  check("...and the old password no longer works", r.status === 401, r.status);

  // ---- signing in again retires the cookie the browser already had
  const rot = client();
  await rot("POST", "/api/login", { username: "admin", password: GOOD });
  const oldCookie = rot.cookie();
  await rot("POST", "/api/login", { username: "admin", password: GOOD });
  const newCookie = rot.cookie();
  const probe = client();
  probe.setCookie(oldCookie);
  check(
    "sign-in gives a new session and ends the old cookie's session",
    oldCookie !== newCookie &&
      (await probe("GET", "/api/me")).status === 401 &&
      (await rot("GET", "/api/me")).status === 200,
    [oldCookie === newCookie],
  );

  // ---- cross-site requests
  const hdr = (o) => ({ ...o });
  const bodyLogin = { username: "admin", password: GOOD };
  const origin = `http://127.0.0.1:${PORT}`;
  const xs = [
    ["another website's Origin", { Origin: "https://evil.example" }, 403],
    ["the literal null Origin", { Origin: "null" }, 403],
    ["same host but another port", { Origin: "http://127.0.0.1:9999" }, 403],
    ["a malformed Origin", { Origin: "not a url" }, 403],
    ["Sec-Fetch-Site: cross-site", { "Sec-Fetch-Site": "cross-site" }, 403],
    ["our own Origin", { Origin: origin }, 200],
    [
      "our own Origin + Sec-Fetch-Site: same-origin",
      { Origin: origin, "Sec-Fetch-Site": "same-origin" },
      200,
    ],
    ["no Origin at all (a script or curl)", {}, 200],
  ];
  for (const [label, headers, want] of xs) {
    r = await client()("POST", "/api/login", bodyLogin, hdr(headers));
    check(`POST with ${label} -> ${want}`, r.status === want, [r.status, r.json]);
  }
  r = await client()("GET", "/api/me", undefined, { Origin: "https://evil.example" });
  check(
    "a GET is not refused for its Origin (it changes nothing)",
    r.status === 401 && r.json.error === "Not signed in",
    r.json,
  );
  r = await client()("POST", "/api/login", bodyLogin, { Origin: "https://evil.example" });
  check("the refusal says why, in plain words", /another website/.test(r.json.error), r.json);

  // ---- big pasted lists
  const adm2 = client();
  await adm2("POST", "/api/login", bodyLogin);
  const line = (i) =>
    `Pasted screen number ${i} in the library, Pasted Space ${i % 7}, 10.${100 + (i >> 8)}.${i & 255}.${1 + (i % 250)}`;
  const text500 = Array.from({ length: 500 }, (_, i) => line(i)).join("\n");
  r = await adm2("POST", "/api/admin/devices/import", {
    kind: "decoders",
    text: text500,
    dryRun: true,
  });
  check(
    `a 500-line paste (${Math.round(text500.length / 1024)} KB) goes through (it used to be cut off at 10 KB)`,
    r.status === 200 && r.json.ok === true && r.json.rows.length === 500,
    [r.status, r.json && r.json.errors && r.json.errors.slice(0, 2)],
  );
  r = await adm2("POST", "/api/admin/devices/import", {
    kind: "decoders",
    text: text500 + "\n" + line(501),
    dryRun: true,
  });
  check(
    "501 lines: the 500-line message",
    r.status === 400 && /at most 500 lines/.test(r.json.error),
    r.json,
  );
  r = await adm2("POST", "/api/admin/devices/import", {
    kind: "decoders",
    text: "x".repeat(350000),
    dryRun: true,
  });
  check(
    "a huge paste is a clean 400 in plain words",
    r.status === 400 && /too large to send in one go/.test(r.json.error),
    [r.status, r.json],
  );
  r = await adm2("POST", "/api/login", { username: "admin", password: "x".repeat(20000) });
  check(
    "an oversized sign-in request is still a clean refusal",
    r.status === 400 || r.status === 401,
    r.status,
  );
  await stop(s);

  // ================= B: idle expiry (2.4 s idle, long maximum)
  const dirB = path.join(tmp, "b");
  s = await start(dirB, { SESSION_IDLE_MINUTES: "0.04", SESSION_MAX_HOURS: "1" });
  const b0 = client();
  await firstLogin(b0, s.out(), GOOD);
  const b = client();
  await b("POST", "/api/login", { username: "admin", password: GOOD });
  check("idle: a fresh session works", (await b("GET", "/api/me")).status === 200);
  await sleep(3200);
  r = await b("GET", "/api/me");
  check(
    "idle: after the idle time the session has ended, with a message that says so",
    r.status === 401 && r.json.signedOut === true && /session has ended/.test(r.json.error),
    [r.status, r.json],
  );
  r = await b("GET", "/api/me");
  check("idle: it does not come back", r.status === 401);

  const keep = client();
  await keep("POST", "/api/login", { username: "admin", password: GOOD });
  let alive = true;
  for (let i = 0; i < 5; i++) {
    await sleep(1100);
    alive = alive && (await keep("GET", "/api/me")).status === 200;
  }
  check(
    "idle: doing things (a request every ~1 s for 5.5 s, past the 2.4 s idle time) keeps the session alive",
    alive,
  );

  const bg = client();
  await bg("POST", "/api/login", { username: "admin", password: GOOD });
  const bgStates = [];
  for (let i = 0; i < 4; i++) {
    await sleep(1000);
    bgStates.push((await bg("GET", "/api/me", undefined, { "X-Background": "1" })).status);
  }
  check(
    "idle: automatic background refreshes do NOT keep a session alive (200, 200, then 401, 401)",
    bgStates[0] === 200 && bgStates[1] === 200 && bgStates[2] === 401 && bgStates[3] === 401,
    bgStates,
  );
  const bg2 = client();
  await bg2("POST", "/api/login", { username: "admin", password: GOOD });
  await sleep(1500);
  await bg2("GET", "/api/me");
  await sleep(1500);
  check(
    "idle: a real request in between resets the idle clock even if background ones came before",
    (await bg2("GET", "/api/me", undefined, { "X-Background": "1" })).status === 200,
  );
  await stop(s);

  // ================= C: absolute maximum (about 4.3 s, long idle)
  const dirC = path.join(tmp, "c");
  s = await start(dirC, { SESSION_IDLE_MINUTES: "60", SESSION_MAX_HOURS: "0.0012" });
  const c0 = client();
  await firstLogin(c0, s.out(), GOOD);
  const cc = client();
  await cc("POST", "/api/login", { username: "admin", password: GOOD });
  const cStates = [];
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    cStates.push((await cc("GET", "/api/me")).status);
  }
  check(
    "maximum: constant activity cannot keep a session past its maximum age (200s, then 401)",
    cStates[0] === 200 && cStates[1] === 200 && cStates[5] === 401 && cStates.indexOf(401) >= 3,
    cStates,
  );
  r = await cc("POST", "/api/login", { username: "admin", password: GOOD });
  check("maximum: signing in again works", r.status === 200);
  await stop(s);

  // ================= D: failed sign-ins from one address, whatever the usernames
  const dirD = path.join(tmp, "d");
  s = await start(dirD, {});
  const d0 = client();
  await firstLogin(d0, s.out(), GOOD);
  const d = client();
  const codes = [];
  for (let i = 0; i < 30; i++)
    codes.push(
      (await d("POST", "/api/login", { username: `nobody${i}`, password: "wrong-wrong-wrong" }))
        .status,
    );
  check(
    "sign-in limit: 30 failures under 30 different usernames are all plain 401s",
    codes.every((c) => c === 401),
    codes.filter((c) => c !== 401),
  );
  r = await d("POST", "/api/login", { username: "admin", password: GOOD });
  check(
    "sign-in limit: the 31st attempt, even with the RIGHT password, is paused for a while (429)",
    r.status === 429 && /Too many attempts/.test(r.json.error),
    [r.status, r.json],
  );
  await stop(s);

  // ================= E: behind a proxy
  const dirE = path.join(tmp, "e");
  s = await start(dirE, { TRUST_PROXY: "1" });
  const e0 = client();
  await firstLogin(e0, s.out(), GOOD);
  r = await client()(
    "POST",
    "/api/login",
    { username: "admin", password: GOOD },
    {
      Origin: "https://av.school.example",
      Host: "internal-box:8080",
      "X-Forwarded-Host": "av.school.example",
    },
  );
  check(
    "proxy: an Origin that matches X-Forwarded-Host is accepted when TRUST_PROXY=1",
    r.status === 200,
    [r.status, r.json],
  );
  r = await client()(
    "POST",
    "/api/login",
    { username: "admin", password: GOOD },
    {
      Origin: "https://evil.example",
      Host: "internal-box:8080",
      "X-Forwarded-Host": "av.school.example",
    },
  );
  check("proxy: another Origin is still refused", r.status === 403, r.status);
  await stop(s);

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
