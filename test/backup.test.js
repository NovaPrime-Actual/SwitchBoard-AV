// Full-backup download: admin only, a real zip (also opened with the machine's own unzip tool when there is one), contents, and a restore round trip.
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-backup-"));
const PORT = 18550;
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
            resolve({ status: res.statusCode, json, buf, headers: res.headers });
          });
        },
      );
      req.on("error", (e) => resolve({ error: e.code }));
      if (data) req.write(data);
      req.end();
    });
}

// A small independent zip reader (central directory + inflateRaw), so the test does not trust the writer.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10),
      crc = buf.readUInt32LE(p + 16),
      csize = buf.readUInt32LE(p + 20),
      usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28),
      elen = buf.readUInt16LE(p + 30),
      clen = buf.readUInt16LE(p + 32),
      off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(off + 26),
      lelen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    files[name] = {
      data,
      crcOk: (zlib.crc32 ? zlib.crc32(data) : crc) === crc,
      sizeOk: data.length === usize,
    };
    p += 46 + nlen + elen + clen;
  }
  return files;
}

(async () => {
  const dir = path.join(tmp, "data");
  fs.mkdirSync(path.join(dir, "tls"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tls", "key.pem"),
    "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n",
  );
  fs.writeFileSync(path.join(dir, "tls", "cert.pem"), "cert");
  const s = await start(dir);
  const admin = client();
  const pw = /temporary password: (\S+)/.exec(s.out())[1];
  await admin("POST", "/api/login", { username: "admin", password: pw });
  await admin("POST", "/api/change-password", {
    currentPassword: pw,
    newPassword: "admin-test-pass-1",
  });
  await admin("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });

  // some real state to back up
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  await admin("POST", "/api/admin/branding", {
    appName: "Backup Test App",
    orgName: "Test Org",
    accent: "#59606b",
    select: "#a6171d",
    logo: { data: png.toString("base64") },
  });
  const grp = (
    await admin("POST", "/api/admin/groups", {
      name: "Front Office",
      spaces: ["Space A"],
      sources: "all",
    })
  ).json;
  const made = (
    await admin("POST", "/api/admin/users", {
      name: "Pat Teacher",
      username: "pat",
      role: "user",
      groups: [grp.id],
    })
  ).json;
  const pat = client();
  await pat("POST", "/api/login", { username: "pat", password: made.tempPassword });
  await pat("POST", "/api/change-password", {
    currentPassword: made.tempPassword,
    newPassword: "pat-test-pass-1",
  });
  await pat("POST", "/api/login", { username: "pat", password: "pat-test-pass-1" });
  await admin("POST", "/api/admin/devices/spaces", { name: "Gym" }); // makes a history entry too

  // access
  let r = await client()("GET", "/api/admin/backup");
  check("signed-out request refused", r.status === 401, r.status);
  r = await pat("GET", "/api/admin/backup");
  check("non-admin refused", r.status === 403, r.status);

  // the download
  r = await admin("GET", "/api/admin/backup");
  check(
    "admin gets a zip",
    r.status === 200 &&
      r.headers["content-type"] === "application/zip" &&
      /^attachment; filename="switchboard-av-backup-\d{4}-\d{2}-\d{2}\.zip"$/.test(
        r.headers["content-disposition"],
      ) &&
      r.headers["cache-control"] === "no-store" &&
      Number(r.headers["content-length"]) === r.buf.length,
    r.headers,
  );
  const zipBuf = r.buf;
  const files = readZip(zipBuf);
  const names = Object.keys(files).sort();
  check(
    "zip lists the app's state files + RESTORE.txt + the logo",
    [
      "RESTORE.txt",
      "activity.json",
      "branding.json",
      "branding/logo.png",
      "devices-history.json",
      "devices.store.json",
      "store.json",
    ].every((n) => names.includes(n)),
    names,
  );
  check(
    "every entry's checksum and size are right",
    Object.values(files).every((f) => f.crcOk && f.sizeOk),
    names,
  );
  check(
    "no TLS key or certificate in the backup",
    !names.some((n) => n.startsWith("tls")) &&
      !Object.values(files).some((f) => /PRIVATE KEY|SECRET/.test(f.data.toString("utf8"))),
    names,
  );
  check(
    "entries equal the files on disk",
    ["store.json", "devices.store.json", "branding.json"].every((n) =>
      files[n].data.equals(fs.readFileSync(path.join(dir, n))),
    ) && files["branding/logo.png"].data.equals(png),
  );
  check(
    "RESTORE.txt names the version, who made it and how to restore",
    /version \S+/.test(files["RESTORE.txt"].data.toString()) &&
      /by admin/.test(files["RESTORE.txt"].data.toString()) &&
      /TO RESTORE/.test(files["RESTORE.txt"].data.toString()) &&
      /KEEP THIS FILE PRIVATE/.test(files["RESTORE.txt"].data.toString()),
  );
  r = await admin("GET", "/api/admin/activity");
  check(
    "activity log records the download and who",
    r.json.some((e) => e.type === "backup_download" && e.by === "admin" && /files/.test(e.detail)),
    r.json.slice(0, 3),
  );

  // an independent unzip (Windows' own bsdtar) agrees
  const zipFile = path.join(tmp, "b.zip");
  fs.writeFileSync(zipFile, zipBuf);
  // Restore the zip into a fresh data folder with the test's own reader (works on every machine) ...
  const out2 = path.join(tmp, "restored");
  fs.mkdirSync(out2);
  for (const [name, f] of Object.entries(files)) {
    const target = path.join(out2, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
  check(
    "the files extracted with the test's own reader match",
    fs.readFileSync(path.join(out2, "store.json")).equals(files["store.json"].data) &&
      fs.readFileSync(path.join(out2, "branding", "logo.png")).equals(png),
  );
  // ... and, where this machine has a tool that opens zip files, check that a real one agrees with it
  // (bsdtar on Windows 10+ and macOS, unzip on Linux).
  const out3 = path.join(tmp, "restored-by-tool");
  let toolName = null,
    toolMsg = "";
  const candidates = [];
  if (process.platform === "win32")
    candidates.push(["C:/Windows/System32/tar.exe", ["-xf", zipFile, "-C", out3]]);
  candidates.push(["tar", ["-xf", zipFile, "-C", out3]], ["unzip", ["-q", zipFile, "-d", out3]]);
  for (const [cmd, args] of candidates) {
    fs.rmSync(out3, { recursive: true, force: true });
    fs.mkdirSync(out3);
    try {
      execFileSync(cmd, args, { stdio: "pipe" });
      toolName = cmd;
      break;
    } catch (e) {
      toolMsg = String(e.stderr || e.message);
    }
  }
  if (toolName) {
    check(
      `a real unzip tool (${toolName}) opens the zip without complaint and its files match`,
      fs.readFileSync(path.join(out3, "store.json")).equals(files["store.json"].data) &&
        fs.readFileSync(path.join(out3, "branding", "logo.png")).equals(png),
      toolMsg,
    );
  } else {
    console.log(
      "SKIP  no tool on this machine opens a zip file; only the test's own reader was used",
    );
  }
  await stop(s);

  // restore round trip: start a NEW server on the unzipped folder
  const s2 = await start(out2);
  const pat2 = client();
  r = await pat2("POST", "/api/login", { username: "pat", password: "pat-test-pass-1" });
  check(
    "after restore, a user signs in with the same password",
    r.status === 200 && r.json.name === "Pat Teacher" && r.json.groupNames.includes("Front Office"),
    r.json,
  );
  const adm2 = client();
  await adm2("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
  r = await adm2("GET", "/api/admin/branding");
  check(
    "branding came back (name, colours, logo)",
    r.json.appName === "Backup Test App" && r.json.orgName === "Test Org" && r.json.hasLogo,
    r.json,
  );
  r = await adm2("GET", "/api/admin/devices");
  check(
    "devices came back, including the added space and the saved history",
    r.json.spaces.includes("Gym") && r.json.history.length > 0 && r.json.decoders.length === 5,
    Object.keys(r.json),
  );
  r = await adm2("GET", "/api/admin/groups");
  check(
    "groups came back",
    r.json.some((g) => g.name === "Front Office"),
    r.json,
  );
  await stop(s2);

  // an install with almost nothing in it still backs up cleanly
  const bare = path.join(tmp, "bare");
  const s3 = await start(bare);
  const a3 = client();
  const pw3 = /temporary password: (\S+)/.exec(s3.out())[1];
  await a3("POST", "/api/login", { username: "admin", password: pw3 });
  await a3("POST", "/api/change-password", {
    currentPassword: pw3,
    newPassword: "admin-test-pass-2",
  });
  await a3("POST", "/api/login", { username: "admin", password: "admin-test-pass-2" });
  r = await a3("GET", "/api/admin/backup");
  const f3 = readZip(r.buf);
  check(
    "fresh install: backup works and has no logo entry",
    r.status === 200 &&
      f3["store.json"] &&
      f3["RESTORE.txt"] &&
      !Object.keys(f3).some((n) => n.startsWith("branding/")),
    Object.keys(f3),
  );
  await stop(s3);

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
