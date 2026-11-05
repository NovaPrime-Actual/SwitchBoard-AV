// Security tab (certificate upload) + HTTPS-by-default checks. Each server process is stopped by its own handle only.
import { spawn, execFileSync } from "node:child_process";
import https from "node:https";
import http from "node:http";
import tlsMod from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { makeSelfSigned } from "../src/tls.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-tlsui-"));
const PORT = 18444;
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400)}`,
  );
};

function start(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(app, "server.js")], {
      cwd: app,
      env: {
        ...process.env,
        DEVICES_FILE: path.join(app, "test/devices.test.json"),
        BIND: "127.0.0.1",
        PORT: String(PORT),
        STATUS_POLL_SECONDS: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let done = false;
    const finish = (extra) => {
      if (!done) {
        done = true;
        resolve({ child, out: () => out, ...extra });
      }
    };
    child.stdout.on("data", (d) => {
      out += d;
      if (/Open https?:\/\//.test(out)) finish({});
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => finish({ exited: code }));
    setTimeout(() => finish({ timeout: true }), 8000);
  });
}
const stop = (s) =>
  new Promise((r) => {
    if (s.child.exitCode !== null) return r();
    s.child.on("exit", () => r());
    s.child.kill();
    setTimeout(r, 2000);
  });

function client(scheme) {
  let cookie = "";
  const lib = scheme === "http" ? http : https;
  return (method, url, body, extra = {}) =>
    new Promise((resolve) => {
      const data =
        body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
      const req = lib.request(
        {
          method,
          host: "127.0.0.1",
          port: PORT,
          path: url,
          rejectUnauthorized: false,
          headers: {
            cookie,
            "content-type": "application/json",
            ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
          },
          ...extra,
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
            resolve({ status: res.statusCode, json, text: b, headers: res.headers });
          });
        },
      );
      req.on("error", (e) => resolve({ error: e.code || e.message }));
      if (data) req.write(data);
      req.end();
    });
}

function servedFingerprint() {
  return new Promise((resolve) => {
    const s = tlsMod.connect(
      { host: "127.0.0.1", port: PORT, rejectUnauthorized: false, servername: "av.test.local" },
      () => {
        const f = s.getPeerCertificate().fingerprint256;
        s.end();
        resolve(f);
      },
    );
    s.on("error", () => resolve(null));
  });
}

async function login(c, out) {
  const pw = /temporary password: (\S+)/.exec(out)[1];
  await c("POST", "/api/login", { username: "admin", password: pw });
  await c("POST", "/api/change-password", {
    currentPassword: pw,
    newPassword: "admin-test-pass-1",
  });
  const r = await c("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
  return r.status === 200;
}

(async () => {
  // ----- test certificates made with openssl: CA, leaf signed by it (password-protected key), a CA-only pair
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
  } catch {
    console.log(
      "SKIP  the certificate-upload checks need the openssl command, which was not found",
    );
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }
  const cd = path.join(tmp, "certs");
  fs.mkdirSync(cd);
  const ssl = (args) => execFileSync("openssl", args, { cwd: cd, stdio: "pipe" });
  ssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "30",
    "-subj",
    "/CN=Test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  ssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-keyout",
    "leaf-enc.key",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=av.test.local",
    "-passout",
    "pass:secret",
  ]);
  fs.writeFileSync(
    path.join(cd, "ext.cnf"),
    "subjectAltName=DNS:av.test.local,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n",
  );
  ssl([
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-passin",
    "pass:secret",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "leaf.pem",
    "-days",
    "30",
    "-extfile",
    "ext.cnf",
  ]);
  ssl(["pkey", "-in", "leaf-enc.key", "-passin", "pass:secret", "-out", "leaf.key"]);
  const rd = (f) => fs.readFileSync(path.join(cd, f), "utf8");
  const leaf = rd("leaf.pem"),
    ca = rd("ca.pem"),
    leafKey = rd("leaf.key"),
    leafEnc = rd("leaf-enc.key"),
    caKey = rd("ca.key");
  const chain = leaf + ca;
  const leafFp = new crypto.X509Certificate(leaf).fingerprint256;
  const other = makeSelfSigned(["localhost"]);

  // ----- 1. default: HTTPS on with no settings at all, even on 127.0.0.1
  const dir = path.join(tmp, "d1");
  let s = await start({ DATA_DIR: dir });
  check(
    "HTTPS is on by default (no TLS settings, loopback)",
    /Open https:\/\//.test(s.out()) && fs.existsSync(path.join(dir, "tls/cert.pem")),
    s.out(),
  );
  const c = client("https");
  check("admin login over default HTTPS", await login(c, s.out()));
  const selfFp = await servedFingerprint();

  let r = await c("GET", "/api/admin/tls");
  check(
    "status: enabled, self-signed, covers localhost, downloadable",
    r.json &&
      r.json.enabled &&
      r.json.kind === "selfsigned" &&
      r.json.names.includes("localhost") &&
      r.json.canDownload &&
      !r.json.hasUploaded &&
      r.json.coversThisAddress === true,
    r.json,
  );
  r = await c("GET", "/api/admin/tls/certificate");
  check(
    "certificate download is the served public cert",
    r.status === 200 &&
      /BEGIN CERTIFICATE/.test(r.text) &&
      new crypto.X509Certificate(r.text).fingerprint256 === selfFp &&
      !/PRIVATE KEY/.test(r.text),
    r.text.slice(0, 80),
  );

  // non-admin is refused
  const cr = await c("POST", "/api/admin/users", {
    name: "Bob",
    username: "bob",
    role: "user",
    groups: [],
  });
  const bob = client("https");
  await bob("POST", "/api/login", { username: "bob", password: cr.json.tempPassword });
  await bob("POST", "/api/change-password", {
    currentPassword: cr.json.tempPassword,
    newPassword: "bob-test-pass-1",
  });
  await bob("POST", "/api/login", { username: "bob", password: "bob-test-pass-1" });
  r = await bob("GET", "/api/admin/tls");
  const r2 = await bob("POST", "/api/admin/tls/upload", { cert: leaf, key: leafKey });
  const r3 = await bob("GET", "/api/admin/tls/certificate");
  check(
    "non-admin cannot see, download or upload certificates",
    r.status === 403 && r2.status === 403 && r3.status === 403,
    [r.status, r2.status, r3.status],
  );
  const anon = client("https");
  r = await anon("GET", "/api/admin/tls");
  check("signed-out request is refused", r.status === 401, r.status);

  // ----- 2. checking files (dry run) gives plain-English answers
  const up = (body) => c("POST", "/api/admin/tls/upload", body);
  r = await up({ cert: chain, key: leafEnc, dryRun: true });
  check(
    "password-protected key without password -> asks for it",
    r.status === 400 && /password-protected/.test(r.json.error),
    r.json,
  );
  r = await up({ cert: chain, key: leafEnc, passphrase: "nope", dryRun: true });
  check(
    "wrong key password -> says so",
    r.status === 400 && /password is wrong/.test(r.json.error),
    r.json,
  );
  r = await up({ cert: chain, key: leafEnc, passphrase: "secret", dryRun: true });
  check(
    "good chain + encrypted key checks out, names listed, chain of 2, not self-signed, no warnings",
    r.status === 200 &&
      r.json.ok &&
      r.json.dryRun &&
      r.json.names.includes("av.test.local") &&
      r.json.chainLength === 2 &&
      r.json.selfSigned === false &&
      r.json.warnings.length === 0 &&
      r.json.coversThisAddress === true,
    r.json,
  );
  r = await up({ cert: ca + leaf, key: leafKey, dryRun: true });
  check(
    "chain in the wrong order still finds the right certificate",
    r.status === 200 && r.json.names.includes("av.test.local"),
    r.json,
  );
  r = await up({ cert: leaf, key: leafKey, dryRun: true });
  check(
    "leaf only -> warns about missing intermediates",
    r.status === 200 && r.json.warnings.some((w) => /intermediate/i.test(w)),
    r.json,
  );
  r = await up({ cert: leafKey, key: leaf, dryRun: true });
  check(
    "boxes swapped -> friendly message",
    r.status === 400 && /private key, not a certificate/.test(r.json.error),
    r.json,
  );
  r = await up({ cert: leaf, key: leaf, dryRun: true });
  check(
    "certificate in the key box -> friendly message",
    r.status === 400 && /certificate, not a key/.test(r.json.error),
    r.json,
  );
  r = await up({ cert: leaf, key: other.keyPem, dryRun: true });
  check(
    "key from a different certificate -> says they do not match",
    r.status === 400 && /does not belong/.test(r.json.error),
    r.json,
  );
  r = await up({ cert: ca, key: caKey, dryRun: true });
  check(
    "a CA certificate is refused as a server cert",
    r.status === 400 && /certificate authority/.test(r.json.error),
    r.json,
  );
  r = await up({ cert: "hello", key: "world", dryRun: true });
  check(
    "garbage -> clear message",
    r.status === 400 && /No certificate found/.test(r.json.error),
    r.json,
  );
  r = await up({ cert: "", key: leafKey, dryRun: true });
  check(
    "empty cert -> asks to choose it",
    r.status === 400 && /certificate file/.test(r.json.error),
    r.json,
  );
  r = await up({
    cert: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
    key: leafKey,
    dryRun: true,
  });
  check(
    "damaged certificate -> clear message",
    r.status === 400 && /damaged/.test(r.json.error),
    r.json,
  );
  r = await up({ cert: "x".repeat(210000), key: leafKey, dryRun: true });
  check(
    "oversized upload -> clean 400, not a dropped connection",
    r.status === 400 && /too large/.test(r.json.error),
    r.status + " " + (r.error || ""),
  );
  check(
    "dry runs changed nothing",
    (await servedFingerprint()) === selfFp && !fs.existsSync(path.join(dir, "tls/custom-cert.pem")),
  );

  // ----- 3. install
  r = await up({ cert: chain, key: leafEnc, passphrase: "secret" });
  check(
    "install succeeds and reports uploaded",
    r.status === 200 && r.json.kind === "uploaded" && r.json.hasUploaded && !r.json.selfSigned,
    r.json,
  );
  check(
    "served certificate switched immediately (no restart)",
    (await servedFingerprint()) === leafFp,
  );
  const storedKey = fs.readFileSync(path.join(dir, "tls/custom-key.pem"), "utf8");
  check(
    "stored key is saved without its password",
    /BEGIN PRIVATE KEY/.test(storedKey) && !/ENCRYPTED/.test(storedKey),
  );
  const real = await new Promise((resolve) => {
    https
      .get({ host: "127.0.0.1", port: PORT, path: "/", ca, servername: "av.test.local" }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", (e) => resolve(e.code));
  });
  check("browser-style validation against the CA now passes (no warning)", real === 200, real);
  r = await c("GET", "/api/admin/activity");
  check(
    "activity log records the install with who",
    r.json.some(
      (e) => e.type === "tls_upload" && e.by === "admin" && /av\.test\.local/.test(e.detail),
    ),
    r.json.slice(0, 3),
  );
  await stop(s);

  // ----- 4. survives a restart
  s = await start({ DATA_DIR: dir });
  check(
    "uploaded certificate still served after restart",
    (await servedFingerprint()) === leafFp && !/WARNING/.test(s.out()),
    s.out(),
  );
  const c4 = client("https");
  await c4("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });

  // ----- 5. reset back to self-signed
  r = await c4("POST", "/api/admin/tls/reset", {});
  check(
    "reset goes back to the self-signed certificate",
    r.status === 200 &&
      r.json.kind === "selfsigned" &&
      !r.json.hasUploaded &&
      (await servedFingerprint()) === selfFp &&
      !fs.existsSync(path.join(dir, "tls/custom-cert.pem")),
    r.json,
  );
  r = await c4("GET", "/api/admin/activity");
  check(
    "activity log records the reset",
    r.json.some((e) => e.type === "tls_reset" && e.by === "admin"),
  );
  await stop(s);

  // ----- 6. a damaged uploaded file does not take the site down
  fs.writeFileSync(path.join(dir, "tls/custom-cert.pem"), "garbage");
  fs.writeFileSync(path.join(dir, "tls/custom-key.pem"), "garbage");
  s = await start({ DATA_DIR: dir });
  check(
    "corrupt uploaded cert -> falls back to self-signed with a warning",
    /could not be used/.test(s.out()) && (await servedFingerprint()) === selfFp,
    s.out(),
  );
  const c6 = client("https");
  await c6("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
  r = await c6("GET", "/api/admin/tls");
  check(
    "status shows why",
    r.json.kind === "selfsigned" && /Uploaded certificate/.test(r.json.fallbackReason || ""),
    r.json,
  );
  await stop(s);
  fs.unlinkSync(path.join(dir, "tls/custom-cert.pem"));
  fs.unlinkSync(path.join(dir, "tls/custom-key.pem"));

  // ----- 7. server settings win and lock the screen
  fs.writeFileSync(path.join(cd, "env-cert.pem"), leaf);
  fs.writeFileSync(path.join(cd, "env-key.pem"), leafKey);
  s = await start({
    DATA_DIR: dir,
    TLS_CERT: path.join(cd, "env-cert.pem"),
    TLS_KEY: path.join(cd, "env-key.pem"),
  });
  const c7 = client("https");
  await c7("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
  r = await c7("GET", "/api/admin/tls");
  check(
    "server-settings cert: status says locked",
    r.json.kind === "server-settings" && r.json.lockedBySettings === true && !r.json.selfSigned,
    r.json,
  );
  r = await c7("POST", "/api/admin/tls/upload", {
    cert: chain,
    key: leafEnc,
    passphrase: "secret",
  });
  check(
    "upload refused while server settings control the certificate",
    r.status === 400 && /server's own settings/.test(r.json.error),
    r.json,
  );
  r = await c7("POST", "/api/admin/tls/reset", {});
  check("reset refused too", r.status === 400, r.json);
  await stop(s);

  // ----- 8. HTTPS off: TLS=off and TRUST_PROXY=1
  s = await start({ DATA_DIR: dir, TLS: "off" });
  const c8 = client("http");
  check("TLS=off serves plain HTTP", /Open http:\/\//.test(s.out()), s.out());
  await c8("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
  r = await c8("GET", "/api/admin/tls");
  check("status says HTTPS is off", r.json && r.json.enabled === false, r.json);
  r = await c8("POST", "/api/admin/tls/upload", { cert: leaf, key: leafKey });
  check(
    "upload refused when HTTPS is off",
    r.status === 400 && /switched off/.test(r.json.error),
    r.json,
  );
  await stop(s);
  s = await start({ DATA_DIR: dir, TRUST_PROXY: "1" });
  check(
    "TRUST_PROXY=1 (proxy does TLS) defaults to plain HTTP",
    /Open http:\/\//.test(s.out()),
    s.out(),
  );
  await stop(s);
  s = await start({ DATA_DIR: dir, TRUST_PROXY: "1", TLS: "selfsigned" });
  check(
    "TRUST_PROXY=1 with TLS=selfsigned still gives HTTPS",
    /Open https:\/\//.test(s.out()),
    s.out(),
  );
  await stop(s);

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
