// Verifies the "No response" reachability flag: unreachable -> false, replying decoder -> true.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, "..");
const DATA = path.join(os.tmpdir(), "switchboard-av-test-noreply-data");
const PORT = 18081;
const base = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(file, env) {
  const c = spawn(process.execPath, [file], { cwd: APP, env: { ...process.env, ...env } });
  children.push(c);
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  return { c, out: () => out };
}

let cookie = "";
async function api(url, body) {
  const res = await fetch(base + url, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: res.status, json: await res.json() };
}

(async () => {
  const results = [];
  try {
    const env = {
      DEVICES_FILE: path.join(APP, "test", "devices.test.json"),
      DATA_DIR: DATA,
      PORT: String(PORT),
      BIND: "127.0.0.1",
      TLS: "off",
    };
    const srv = start("server.js", env);
    await sleep(1500);
    const pw = /temporary password: (\S+)/.exec(srv.out())[1];
    if (!/devices.test.json/.test(srv.out()))
      throw new Error("server not using the test devices file!");
    await api("/api/login", { username: "admin", password: pw });
    await api("/api/change-password", { currentPassword: pw, newPassword: "scratch-noreply-1" });
    await api("/api/login", { username: "admin", password: "scratch-noreply-1" });

    const before = (await api("/api/devices")).json.decoders;
    results.push(["before any query: reachable null", before.every((d) => d.reachable === null)]);

    await api("/api/refresh", {}); // no mock running -> all time out
    const r1 = (await api("/api/devices")).json.decoders;
    results.push([
      "no decoders answering: reachable false for all",
      r1.length === 5 && r1.every((d) => d.reachable === false),
    ]);

    const mock = start("test/mock-decoders.js", {});
    await sleep(800);
    await api("/api/refresh", {});
    const r2 = (await api("/api/devices")).json.decoders;
    // the test devices file marks one screen mockOffline: the pretend decoders never answer for it
    const testDevices = JSON.parse(
      fs.readFileSync(path.join(APP, "test", "devices.test.json"), "utf8"),
    );
    const offline = new Set(testDevices.decoders.filter((d) => d.mockOffline).map((d) => d.ip));
    results.push([
      "mock answering: reachable true for every screen except the one flagged mockOffline (which stays false)",
      offline.size >= 1 && r2.every((d) => d.reachable === !offline.has(d.ip)),
    ]);
    results.push([
      "answering decoder with no source: host still null (shows Not read yet)",
      r2.every((d) => d.host === null),
    ]);
    mock.c.kill();
    await sleep(500);
    await api("/api/refresh", {});
    const r3 = (await api("/api/devices")).json.decoders;
    results.push([
      "mock stopped again: back to reachable false",
      r3.every((d) => d.reachable === false),
    ]);
  } catch (e) {
    results.push(["ERROR " + e.message, false]);
  } finally {
    for (const c of children)
      try {
        c.kill();
      } catch (err) {
        console.log(`could not stop a child process: ${err.message}`);
      }
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  for (const [name, ok] of results) console.log(ok ? "PASS" : "FAIL", name);
  process.exit(results.every((r) => r[1]) ? 0 : 1);
})();
