// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// TLS SETUP for SWITCHBOARD-AV  (HTTPS without a reverse proxy)
// Description: Works out what certificate the web server should use, and (for the "self-signed"
//   fallback) makes one with Node built-ins only, so there is nothing extra to install. Also checks
//   and stores certificates uploaded from the admin Security tab. Used by server.js.
//
//   HTTPS is ON BY DEFAULT. Turn it off with TLS=off (or TRUST_PROXY=1 when a proxy does the TLS).
//   Certificate, in order of preference:
//     1. server settings: TLS_CERT + TLS_KEY (PEM files) or TLS_PFX (+ TLS_PASSPHRASE)
//     2. a certificate uploaded in the admin Security tab (data/tls/custom-*.pem)
//     3. a self-signed certificate made by the app (data/tls/cert.pem; TLS_HOSTS adds names/IPs)
//   Each step falls back to the next if it cannot be used, so the site is never plain HTTP by accident.
// No npm packages needed (Node built-ins only).
// ===========================================

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import tlsModule from "node:tls";

const renewDays = 30; // a self-signed cert is replaced when it has less than this left
const validDays = 730; // how long a new self-signed cert lasts

// ---------- minimal DER writer (just what an X.509 certificate needs) ----------
function enc(tag, body) {
  const l = body.length;
  let head;
  if (l < 128) head = Buffer.from([tag, l]);
  else if (l < 256) head = Buffer.from([tag, 0x81, l]);
  else head = Buffer.from([tag, 0x82, l >> 8, l & 255]);
  return Buffer.concat([head, body]);
}
const seq = (...p) => enc(0x30, Buffer.concat(p));
const set = (...p) => enc(0x31, Buffer.concat(p));
const octet = (b) => enc(0x04, b);
const bool = (v) => enc(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s) => enc(0x0c, Buffer.from(s, "utf8"));
const bitString = (b) => enc(0x03, Buffer.concat([Buffer.from([0]), b]));
function oid(str) {
  const p = str.split(".").map(Number);
  const bytes = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    const t = [n & 0x7f];
    let v = n >>> 7;
    while (v > 0) {
      t.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(...t);
  }
  return enc(0x06, Buffer.from(bytes));
}
function posInt(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return enc(0x02, b);
}
function utcTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  return enc(
    0x17,
    Buffer.from(
      `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`,
      "ascii",
    ),
  );
}
const ext = (o, critical, valueDer) =>
  seq(oid(o), ...(critical ? [bool(true)] : []), octet(valueDer));
const name = (cn, org) =>
  seq(set(seq(oid("2.5.4.10"), utf8(org))), set(seq(oid("2.5.4.3"), utf8(cn))));

function ipBytes(ip) {
  const clean = String(ip).split("%")[0];
  if (net.isIPv4(clean)) return Buffer.from(clean.split(".").map(Number));
  if (net.isIPv6(clean) && !clean.includes(".")) {
    const [head, tail] = clean.split("::");
    const hp = head ? head.split(":") : [];
    const tp = tail ? tail.split(":") : [];
    const fill = clean.includes("::") ? 8 - hp.length - tp.length : 0;
    const groups = [...hp, ...Array(Math.max(fill, 0)).fill("0"), ...tp];
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return Buffer.concat(groups.map((g) => Buffer.from(g.padStart(4, "0"), "hex")));
  }
  return null;
}

function pem(label, der) {
  const b64 = der
    .toString("base64")
    .match(/.{1,64}/g)
    .join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

// Makes a self-signed certificate (ECDSA P-256 / SHA-256) valid for the given names and IPs.
function makeSelfSigned(hosts) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sanItems = [];
  for (const h of hosts) {
    const b = ipBytes(h);
    if (b)
      sanItems.push(enc(0x87, b)); // iPAddress
    else if (/^[A-Za-z0-9*.-]{1,253}$/.test(h)) sanItems.push(enc(0x82, Buffer.from(h, "ascii"))); // dNSName
  }
  const commonName =
    hosts.find((h) => !ipBytes(h) && h !== "localhost" && /^[A-Za-z0-9.-]{1,60}$/.test(h)) ||
    "SwitchBoard-AV";
  const sigAlg = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const dn = name(commonName, "SwitchBoard-AV (self-signed)");
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000); // a day back, so a slightly slow clock still works
  const notAfter = new Date(Date.now() + validDays * 24 * 3600 * 1000);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    enc(0xa0, enc(0x02, Buffer.from([2]))), // version 3
    posInt(serial),
    sigAlg,
    dn,
    seq(utcTime(notBefore), utcTime(notAfter)),
    dn,
    publicKey.export({ type: "spki", format: "der" }),
    enc(
      0xa3,
      seq(
        ext("2.5.29.19", true, seq()), // not a CA
        ext("2.5.29.15", true, enc(0x03, Buffer.from([7, 0x80]))), // digitalSignature
        ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // serverAuth
        ext("2.5.29.17", false, seq(...sanItems)),
      ),
    ),
  );
  const signature = crypto.sign("sha256", tbs, privateKey);
  const certDer = seq(tbs, sigAlg, bitString(signature));
  return {
    certPem: pem("CERTIFICATE", certDer),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

function wantedHosts(env) {
  const set = new Set(["localhost", "127.0.0.1", "::1"]);
  const hn = localHostname();
  if (hn) set.add(hn);
  for (const address of localIPv4Addresses()) set.add(address);
  for (const h of String(env.TLS_HOSTS || "").split(",")) {
    const t = h.trim();
    if (t) set.add(t);
  }
  return [...set];
}

// The machine's own names are only a convenience for the certificate, so a failed lookup yields none.
function localHostname() {
  try {
    return os.hostname();
  } catch {
    return "";
  }
}

function localIPv4Addresses() {
  try {
    return Object.values(os.networkInterfaces())
      .flatMap((list) => list || [])
      .filter((a) => !a.internal && a.family === "IPv4")
      .map((a) => a.address);
  } catch {
    return [];
  }
}

function covers(x509, host) {
  try {
    return (ipBytes(host) ? x509.checkIP(host) : x509.checkHost(host)) !== undefined;
  } catch {
    return false;
  }
}

function readIfThere(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// Reuses the saved self-signed cert unless it is missing, nearly expired or lacks a wanted name.
function ensureSelfSigned(dataDir, env) {
  const dir = path.join(dataDir, "tls");
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  const hosts = wantedHosts(env);
  const certBuf = readIfThere(certPath);
  const keyBuf = readIfThere(keyPath);
  let fresh = null;
  if (certBuf && keyBuf) {
    try {
      const x = new crypto.X509Certificate(certBuf);
      const daysLeft = (new Date(x.validTo) - Date.now()) / 86400000;
      const matches = x.checkPrivateKey(crypto.createPrivateKey(keyBuf));
      if (daysLeft > renewDays && matches && hosts.every((h) => covers(x, h)))
        fresh = { certBuf, keyBuf, created: false };
    } catch {
      fresh = null; // saved certificate unreadable or mismatched: make a new one below
    }
  }
  if (!fresh) {
    const made = makeSelfSigned(hosts);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text, mode] of [
      [certPath, made.certPem, 0o644],
      [keyPath, made.keyPem, 0o600],
    ]) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, text, { mode });
      fs.renameSync(tmp, file);
    }
    fresh = { certBuf: Buffer.from(made.certPem), keyBuf: Buffer.from(made.keyPem), created: true };
  }
  return { ...fresh, certPath, hosts };
}

// ---------- certificates uploaded from the admin screen ----------
const uploadedNames = { cert: "custom-cert.pem", key: "custom-key.pem" };
const uploadedPaths = (dataDir) => ({
  cert: path.join(dataDir, "tls", uploadedNames.cert),
  key: path.join(dataDir, "tls", uploadedNames.key),
});

function altNames(x509) {
  const san = x509.subjectAltName || "";
  return san
    .split(/,\s*/)
    .map((s) => s.replace(/^DNS:/, "").replace(/^IP Address:/, ""))
    .filter(Boolean);
}

function describe(x509) {
  const validTo = new Date(x509.validTo);
  return {
    subject: x509.subject.replace(/\n/g, ", "),
    issuer: x509.issuer.replace(/\n/g, ", "),
    names: altNames(x509),
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    daysLeft: Math.floor((validTo - Date.now()) / 86400000),
    expired: validTo < new Date(),
    fingerprint: x509.fingerprint256,
    selfSigned: x509.subject === x509.issuer,
  };
}

// Checks a certificate + key a person chose in the admin screen and explains problems in plain
// words. Returns what would be saved (the leaf certificate first, then any chain, and the key
// without its password) plus a summary and warnings. Throws Error(plain message) if unusable.
function inspectUpload(certText, keyText, passphrase) {
  certText = String(certText || "");
  keyText = String(keyText || "");
  if (!certText.trim()) throw new Error("Choose the certificate file first.");
  if (!keyText.trim()) throw new Error("Choose the key file first.");
  if (certText.length > 100000 || keyText.length > 20000)
    throw new Error("Those files are too large to be a certificate and key.");
  const blocks = certText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks) {
    if (/PRIVATE KEY-----/.test(certText))
      throw new Error(
        "That looks like a private key, not a certificate. Check the two files are in the right boxes.",
      );
    throw new Error(
      "No certificate found in that file. A certificate file starts with -----BEGIN CERTIFICATE-----. (.pfx and .p12 files cannot be uploaded here.)",
    );
  }
  if (!/PRIVATE KEY-----/.test(keyText)) {
    if (/-----BEGIN CERTIFICATE-----/.test(keyText))
      throw new Error(
        "That looks like a certificate, not a key. Check the two files are in the right boxes.",
      );
    throw new Error(
      "No private key found in that file. A key file starts with -----BEGIN PRIVATE KEY----- (or RSA / EC / ENCRYPTED PRIVATE KEY).",
    );
  }
  let keyObj;
  try {
    keyObj = crypto.createPrivateKey({ key: keyText, passphrase: passphrase || undefined });
  } catch (err) {
    const protectedKey = /ENCRYPTED/.test(keyText) || /passphrase|decrypt/i.test(err.message);
    if (protectedKey)
      throw new Error(
        passphrase
          ? "The key password is wrong."
          : "This key is password-protected. Enter its password.",
        { cause: err },
      );
    throw new Error("The key file cannot be read. It may be damaged or in an unsupported format.", {
      cause: err,
    });
  }
  let certs;
  try {
    certs = blocks.map((b) => ({ pem: b, x: new crypto.X509Certificate(b) }));
  } catch (err) {
    throw new Error("The certificate file is damaged or not a valid certificate.", { cause: err });
  }
  const leafIndex = certs.findIndex((c) => c.x.checkPrivateKey(keyObj));
  if (leafIndex < 0)
    throw new Error(
      "That key does not belong to that certificate. Make sure both came from the same request.",
    );
  const leaf = certs[leafIndex];
  const chain = [leaf, ...certs.filter((_, i) => i !== leafIndex)];
  if (leaf.x.ca)
    throw new Error(
      "That is a certificate authority (CA) certificate, not a server certificate. Use the one issued for this server.",
    );
  const info = describe(leaf.x);
  if (info.expired) throw new Error(`That certificate expired on ${leaf.x.validTo}.`);
  if (new Date(leaf.x.validFrom) > new Date(Date.now() + 86400000))
    throw new Error(`That certificate is not valid until ${leaf.x.validFrom}.`);
  const warnings = [];
  if (info.names.length === 0)
    warnings.push("It lists no server names, so current browsers will refuse it.");
  if (info.selfSigned) warnings.push("It is self-signed, so browsers will still show a warning.");
  else if (certs.length === 1)
    warnings.push(
      "No intermediate certificates are included. Some devices may not trust it; the CA usually provides a 'full chain' file.",
    );
  return {
    certPem: chain.map((c) => c.pem).join("\n") + "\n",
    keyPem: keyObj.export({ type: "pkcs8", format: "pem" }),
    x509: leaf.x,
    summary: { ...info, chainLength: certs.length, warnings },
  };
}

function writePrivate(file, text, mode) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

function saveUploaded(dataDir, checked) {
  const p = uploadedPaths(dataDir);
  fs.mkdirSync(path.dirname(p.cert), { recursive: true });
  writePrivate(p.key, checked.keyPem, 0o600);
  writePrivate(p.cert, checked.certPem, 0o644);
}

function removeUploaded(dataDir) {
  const p = uploadedPaths(dataDir);
  for (const f of [p.cert, p.key]) {
    try {
      fs.unlinkSync(f);
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // already gone is the goal
    }
  }
}

// Works out whether HTTPS is on, and from where the certificate comes. Returns null for plain HTTP.
// HTTPS is ON BY DEFAULT. It is off only when TLS=off, or when TRUST_PROXY=1 says a proxy in front
// does the TLS (unless TLS or a certificate is set explicitly). Order of preference, each falling
// back to the next if it cannot be used:
//   1. server settings (TLS_CERT + TLS_KEY, or TLS_PFX)   2. a certificate uploaded in the admin screen
//   3. the self-signed certificate the app makes for itself (always works)
// build() reads everything again and returns { options, sig, info, x509 }. build({ keepReal: true }) is what the
// hourly re-check uses: it throws instead of replacing a working real certificate with the self-signed one.
function setup(env, dataDir) {
  const pfxFile = env.TLS_PFX;
  const certFile = env.TLS_CERT;
  const keyFile = env.TLS_KEY;
  const passphrase = env.TLS_PASSPHRASE || undefined;
  const setting = String(env.TLS || "").toLowerCase();
  const off = /^(off|0|false|no|none)$/.test(setting);
  const forced = /^(selfsigned|self-signed|1|on|true)$/.test(setting);
  const hasEnvCert = Boolean(pfxFile || certFile || keyFile);
  const proxied = env.TRUST_PROXY === "1";
  if (off || (proxied && !(hasEnvCert || forced))) return null;

  function buildEnv() {
    if (pfxFile) {
      let pfx;
      let st;
      try {
        pfx = fs.readFileSync(path.resolve(pfxFile));
        st = fs.statSync(path.resolve(pfxFile));
      } catch (err) {
        throw new Error(`Cannot read the certificate file: ${err.message}`, { cause: err });
      }
      try {
        tlsModule.createSecureContext({ pfx, passphrase }); // throws on a wrong password or a damaged file
      } catch (err) {
        throw new Error(`The .pfx file cannot be used: ${err.message}`, { cause: err });
      }
      return {
        options: { pfx, passphrase },
        sig: `pfx:${st.size}:${st.mtimeMs}`,
        info: { source: `PFX file ${pfxFile}` },
      };
    }
    if (!certFile || !keyFile)
      throw new Error("TLS_CERT and TLS_KEY must both be set (or use TLS_PFX).");
    let certBuf;
    let keyBuf;
    try {
      certBuf = fs.readFileSync(path.resolve(certFile));
      keyBuf = fs.readFileSync(path.resolve(keyFile));
    } catch (err) {
      throw new Error(`Cannot read the certificate files: ${err.message}`, { cause: err });
    }
    return finish(certBuf, keyBuf, passphrase, `certificate ${certFile}`, {});
  }

  function buildUploaded() {
    const p = uploadedPaths(dataDir);
    let certBuf;
    let keyBuf;
    try {
      certBuf = fs.readFileSync(p.cert);
      keyBuf = fs.readFileSync(p.key);
    } catch (err) {
      throw new Error(`Cannot read the uploaded certificate: ${err.message}`, { cause: err });
    }
    return finish(certBuf, keyBuf, undefined, "certificate uploaded in the admin screen", {});
  }

  function buildSelfSigned() {
    const s = ensureSelfSigned(dataDir, env);
    return finish(s.certBuf, s.keyBuf, undefined, `self-signed certificate ${s.certPath}`, {
      created: s.created,
      hosts: s.hosts,
    });
  }

  // Checks that the certificate and key belong together and describes the result.
  function finish(certBuf, keyBuf, pass, source, extra) {
    let x509;
    try {
      x509 = new crypto.X509Certificate(certBuf);
      if (!x509.checkPrivateKey(crypto.createPrivateKey({ key: keyBuf, passphrase: pass }))) {
        throw new Error("the key does not belong to this certificate");
      }
    } catch (err) {
      throw new Error(`The certificate cannot be used: ${err.message}`, { cause: err });
    }
    return {
      options: { cert: certBuf, key: keyBuf, passphrase: pass },
      sig: x509.fingerprint256,
      x509,
      info: { source, ...describe(x509), ...extra },
    };
  }

  function build(buildOpts = {}) {
    const problems = [];
    const attempt = (kind, label, fn) => {
      try {
        const r = fn();
        r.info.kind = kind;
        return r;
      } catch (err) {
        problems.push(`${label}: ${err.message}`);
        return null;
      }
    };
    let r = null;
    if (hasEnvCert) r = attempt("server-settings", "Server settings", buildEnv);
    if (!r && fs.existsSync(uploadedPaths(dataDir).cert))
      r = attempt("uploaded", "Uploaded certificate", buildUploaded);
    if (!r) {
      r = buildSelfSigned();
      r.info.kind = "selfsigned";
    }
    if (problems.length) r.info.fallbackReason = problems.join(" ");
    if (buildOpts.keepReal && r.info.kind === "selfsigned")
      throw new Error(problems.join(" ") || "no usable certificate found");
    return r;
  }

  return { hasEnvCert, build };
}

export { setup, makeSelfSigned, inspectUpload, saveUploaded, removeUploaded, uploadedPaths };
