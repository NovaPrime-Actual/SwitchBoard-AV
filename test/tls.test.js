// TLS checks for visionary-web v2.8. Starts its own server processes and stops each by PID only.
import { spawn, execFileSync } from "node:child_process";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { makeSelfSigned } from "../src/tls.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-tls-"));
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + (extra ?? "")}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(env) {
  return new Promise((resolve) => {
    const dataDir = env.DATA_DIR;
    const child = spawn(process.execPath, [path.join(app, "server.js")], {
      cwd: app,
      env: {
        ...process.env,
        DEVICES_FILE: path.join(app, "test/devices.test.json"),
        BIND: "127.0.0.1",
        PORT: "18443",
        STATUS_POLL_SECONDS: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    child.stdout.on("data", (d) => {
      out += d;
      if (/Open https?:\/\//.test(out)) finish({ child, out: () => out, dataDir });
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("exit", (code) => finish({ child, out: () => out, exited: code, dataDir }));
    setTimeout(() => finish({ child, out: () => out, timeout: true, dataDir }), 8000);
  });
}
function stop(s) {
  return new Promise((r) => {
    if (s.child.exitCode !== null) return r();
    s.child.on("exit", () => r());
    s.child.kill();
    setTimeout(r, 2000);
  });
}

function get(opts, body) {
  return new Promise((resolve) => {
    const lib = opts.protocol === "http:" ? http : https;
    const req = lib.request(opts, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(4000, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}
const secure = (extra) => ({
  protocol: "https:",
  host: "127.0.0.1",
  port: 18443,
  path: "/",
  method: "GET",
  ...extra,
});

(async () => {
  // ---- 1. self-signed, fresh data dir
  const d1 = path.join(tmp, "d1");
  let s = await start({
    DATA_DIR: d1,
    TLS: "selfsigned",
    TLS_HOSTS: "av.test.local",
    HTTP_REDIRECT_PORT: "18080",
  });
  check("self-signed server starts", /Open https:\/\//.test(s.out()), s.out());
  check("says HTTPS is on + newly made", /HTTPS +on/.test(s.out()) && /newly made/.test(s.out()));
  check(
    "prints fingerprint and warning",
    /Cert SHA-256 +[0-9A-F]{2}:/.test(s.out()) && /rowsers will show a warning/.test(s.out()),
  );
  const certPem = fs.readFileSync(path.join(d1, "tls/cert.pem"));
  const x = new crypto.X509Certificate(certPem);
  check(
    "cert covers extra host + localhost + 127.0.0.1",
    x.checkHost("av.test.local") && x.checkHost("localhost") && x.checkIP("127.0.0.1"),
  );
  const fp1 = x.fingerprint256;
  const pw = (/temporary password: (\S+)/.exec(s.out()) || [])[1];

  let r = await get(secure({ ca: certPem }));
  check(
    "trusted when the cert is supplied as CA (real validation on)",
    r.status === 200 && /<title>/i.test(r.body),
    JSON.stringify(r).slice(0, 200),
  );
  r = await get(secure());
  check(
    "rejected by default (self-signed untrusted)",
    /SELF_SIGNED|DEPTH_ZERO/.test(r.error || ""),
    JSON.stringify(r).slice(0, 200),
  );
  r = await get(
    secure({ ca: certPem, servername: "av.test.local", headers: { host: "av.test.local:18443" } }),
  );
  check(
    "name av.test.local also validates (SNI)",
    r.status === 200,
    JSON.stringify(r).slice(0, 200),
  );
  check("no HSTS header by default", !(r.headers && r.headers["strict-transport-security"]));
  r = await get({ protocol: "http:", host: "127.0.0.1", port: 18443, path: "/" });
  check(
    "plain HTTP on the HTTPS port is not served",
    r.error || r.status !== 200,
    JSON.stringify(r).slice(0, 200),
  );

  const body = JSON.stringify({ username: "admin", password: pw });
  r = await get(
    secure({
      ca: certPem,
      path: "/api/login",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }),
    body,
  );
  const ck = [].concat((r.headers && r.headers["set-cookie"]) || []).join(";");
  check("login over HTTPS works", r.status === 200, JSON.stringify(r).slice(0, 200));
  check(
    "session cookie is Secure+HttpOnly+SameSite=Strict",
    /Secure/.test(ck) && /HttpOnly/.test(ck) && /SameSite=Strict/.test(ck),
    ck,
  );

  // redirect
  r = await get({
    protocol: "http:",
    host: "127.0.0.1",
    port: 18080,
    path: "/api/x?y=1",
    headers: { host: "av.test.local:18080" },
  });
  check(
    "HTTP redirect -> https same host, new port, path kept",
    r.status === 307 && r.headers.location === "https://av.test.local:18443/api/x?y=1",
    JSON.stringify(r).slice(0, 200),
  );
  for (const bad of ["evil.com/@x", "a b", "x.com\\@evil.com"]) {
    r = await get({
      protocol: "http:",
      host: "127.0.0.1",
      port: 18080,
      path: "/",
      headers: { host: bad },
    });
    check(
      `redirect refuses odd Host "${bad}"`,
      r.status === 400 || r.error,
      JSON.stringify(r).slice(0, 120),
    );
  }

  // plain http:// typed at the HTTPS port itself is redirected too (no extra port needed)
  r = await get({ protocol: "http:", host: "127.0.0.1", port: 18443, path: "/index.html?a=1" });
  check(
    "plain HTTP on the HTTPS port redirects to the https front page on the same port",
    r.status === 307 && r.headers.location === "https://127.0.0.1:18443/",
    JSON.stringify(r).slice(0, 200),
  );
  await stop(s);

  // ---- 2. restart, same data dir: cert reused
  s = await start({ DATA_DIR: d1, TLS: "selfsigned", TLS_HOSTS: "av.test.local" });
  const fp2 = new crypto.X509Certificate(fs.readFileSync(path.join(d1, "tls/cert.pem")))
    .fingerprint256;
  check("restart reuses the same cert", fp1 === fp2 && !/newly made/.test(s.out()));
  check("no redirect without HTTP_REDIRECT_PORT", !/redirects to/.test(s.out()));
  await stop(s);

  // ---- 3. new host name -> regenerated
  s = await start({ DATA_DIR: d1, TLS: "selfsigned", TLS_HOSTS: "av.test.local,other.test" });
  const x3 = new crypto.X509Certificate(fs.readFileSync(path.join(d1, "tls/cert.pem")));
  check(
    "adding a name regenerates and covers both",
    x3.fingerprint256 !== fp1 &&
      x3.checkHost("other.test") &&
      x3.checkHost("av.test.local") &&
      /newly made/.test(s.out()),
  );
  const certPem3 = fs.readFileSync(path.join(d1, "tls/cert.pem"));
  const keyPem3 = fs.readFileSync(path.join(d1, "tls/key.pem"));
  await stop(s);

  // ---- 4. own PEM files + HSTS + reload
  const pemDir = path.join(tmp, "pem");
  fs.mkdirSync(pemDir);
  fs.writeFileSync(path.join(pemDir, "c.pem"), certPem3);
  fs.writeFileSync(path.join(pemDir, "k.pem"), keyPem3);
  s = await start({
    DATA_DIR: path.join(tmp, "d4"),
    TLS_CERT: path.join(pemDir, "c.pem"),
    TLS_KEY: path.join(pemDir, "k.pem"),
    HSTS: "1",
    TLS_RELOAD_SECONDS: "1",
  });
  r = await get(secure({ ca: certPem3 }));
  check("PEM mode serves HTTPS", r.status === 200, JSON.stringify(r).slice(0, 200));
  check(
    "HSTS header present when HSTS=1",
    /max-age=\d+/.test((r.headers || {})["strict-transport-security"] || ""),
    JSON.stringify(r.headers),
  );
  // swap in a brand new cert and key while running
  const fresh = makeSelfSigned(["localhost", "127.0.0.1"]);
  fs.writeFileSync(path.join(pemDir, "c.pem"), fresh.certPem);
  fs.writeFileSync(path.join(pemDir, "k.pem"), fresh.keyPem);
  await sleep(2500);
  r = await get(secure({ ca: Buffer.from(fresh.certPem) }));
  check(
    "renewed cert is picked up without restart",
    r.status === 200,
    JSON.stringify(r).slice(0, 200),
  );
  check("reload is logged", /certificate reloaded/.test(s.out()), s.out().slice(-300));
  // half-written / mismatched files must not break the running server
  fs.writeFileSync(path.join(pemDir, "k.pem"), keyPem3); // key no longer matches cert
  await sleep(2500);
  r = await get(secure({ ca: Buffer.from(fresh.certPem) }));
  check(
    "bad replacement is refused, old cert keeps serving",
    r.status === 200 && /could not reload/.test(s.out()),
    s.out().slice(-300),
  );
  await stop(s);

  // ---- 5. PFX
  const pfxPath = path.join(tmp, "c.pfx");
  try {
    execFileSync(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-inkey",
        path.join(d1, "tls/key.pem"),
        "-in",
        path.join(d1, "tls/cert.pem"),
        "-out",
        pfxPath,
        "-passout",
        "pass:pw1",
      ],
      { stdio: "pipe" },
    );
    s = await start({ DATA_DIR: path.join(tmp, "d5"), TLS_PFX: pfxPath, TLS_PASSPHRASE: "pw1" });
    r = await get(secure({ ca: certPem3 }));
    check("PFX mode serves HTTPS", r.status === 200, JSON.stringify(r).slice(0, 200) + s.out());
    await stop(s);
    const d5b = path.join(tmp, "d5b");
    s = await start({ DATA_DIR: d5b, TLS_PFX: pfxPath, TLS_PASSPHRASE: "wrong" });
    const own5 = fs.readFileSync(path.join(d5b, "tls/cert.pem"));
    r = await get(secure({ ca: own5 }));
    check(
      "wrong PFX passphrase falls back to self-signed (still HTTPS)",
      r.status === 200 &&
        /could not be used/.test(s.out()) &&
        /.pfx file cannot be used/.test(s.out()),
      JSON.stringify(r).slice(0, 150) + s.out(),
    );
    await stop(s);
  } catch (e) {
    if (e.code === "ENOENT")
      console.log("SKIP  the .pfx checks need the openssl command, which was not found");
    else check("PFX setup", false, e.message);
  }

  // ---- 6. unusable cert settings fall back to self-signed (never plain HTTP)
  async function fallbackCase(label, env, reason) {
    const dir = path.join(tmp, "f-" + label);
    const sx = await start({ DATA_DIR: dir, ...env });
    let ownCert;
    try {
      ownCert = fs.readFileSync(path.join(dir, "tls/cert.pem"));
    } catch {
      ownCert = null; // no saved certificate yet
    }
    const rr = ownCert ? await get(secure({ ca: ownCert })) : { error: "no self-signed cert made" };
    check(
      label + ": falls back to self-signed over HTTPS",
      rr.status === 200 &&
        reason.test(sx.out()) &&
        /Using a self-signed certificate for now/.test(sx.out()),
      JSON.stringify(rr).slice(0, 150) + sx.out(),
    );
    await stop(sx);
  }
  await fallbackCase(
    "TLS_CERT without TLS_KEY",
    { TLS_CERT: path.join(pemDir, "c.pem") },
    /must both be set/,
  );
  await fallbackCase(
    "missing files",
    { TLS_CERT: path.join(tmp, "nope.pem"), TLS_KEY: path.join(tmp, "nope.key") },
    /Cannot read the certificate files/,
  );
  await fallbackCase(
    "mismatched key/cert",
    { TLS_CERT: path.join(pemDir, "c.pem"), TLS_KEY: path.join(pemDir, "k.pem") },
    /cannot be used/,
  );
  await fallbackCase(
    "garbage cert file",
    {
      TLS_CERT:
        (fs.writeFileSync(path.join(tmp, "junk.pem"), "not a cert"), path.join(tmp, "junk.pem")),
      TLS_KEY: path.join(pemDir, "k.pem"),
    },
    /cannot be used/,
  );

  // fallback now, real files appear later -> picked up by the reload, no restart
  const late = path.join(tmp, "late");
  fs.mkdirSync(late);
  s = await start({
    DATA_DIR: path.join(tmp, "d6late"),
    TLS_CERT: path.join(late, "c.pem"),
    TLS_KEY: path.join(late, "k.pem"),
    TLS_RELOAD_SECONDS: "1",
  });
  const real = makeSelfSigned(["localhost", "127.0.0.1"]);
  r = await get(secure({ ca: Buffer.from(real.certPem) }));
  check(
    "before the files exist the real cert is NOT served",
    r.error,
    JSON.stringify(r).slice(0, 120),
  );
  fs.writeFileSync(path.join(late, "c.pem"), real.certPem);
  fs.writeFileSync(path.join(late, "k.pem"), real.keyPem);
  await sleep(2500);
  r = await get(secure({ ca: Buffer.from(real.certPem) }));
  check(
    "once the files are fixed the real cert replaces the fallback",
    r.status === 200 && /certificate reloaded/.test(s.out()),
    JSON.stringify(r).slice(0, 150) + s.out().slice(-300),
  );
  await stop(s);

  // ---- 7. no TLS: unchanged HTTP behaviour
  s = await start({
    DATA_DIR: path.join(tmp, "d7"),
    BIND: "0.0.0.0",
    TLS: "off",
    HTTP_REDIRECT_PORT: "18081",
    HSTS: "1",
  });
  r = await get({ protocol: "http:", host: "127.0.0.1", port: 18443, path: "/" });
  check(
    "no TLS: plain HTTP works",
    r.status === 200 && !(r.headers || {})["strict-transport-security"],
    JSON.stringify(r).slice(0, 200),
  );
  check(
    "no TLS: warns about network HTTP and ignored settings",
    /plain HTTP/.test(s.out()) &&
      /HTTP_REDIRECT_PORT is ignored/.test(s.out()) &&
      /HSTS is ignored/.test(s.out()),
    s.out(),
  );
  await stop(s);

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
