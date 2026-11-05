// A devices.store.json written by v2.2 (before spaces were a list) must still load, with spaces derived.
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, "..");
const DATA = path.join(os.tmpdir(), "switchboard-av-test-legacy-data");
const PORT = 18090;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const seed = JSON.parse(fs.readFileSync(path.join(APP, "test", "devices.test.json"), "utf8"));
  fs.writeFileSync(
    path.join(DATA, "devices.store.json"),
    JSON.stringify({ updatedAt: 1, decoders: seed.decoders, encoders: seed.encoders }),
  ); // no "spaces"
  const env = {
    ...process.env,
    DEVICES_FILE: path.join(APP, "test", "devices.test.json"),
    DATA_DIR: DATA,
    PORT: String(PORT),
    BIND: "127.0.0.1",
    TLS: "off",
  };
  const srv = spawn(process.execPath, ["server.js"], { cwd: APP, env });
  let out = "";
  srv.stdout.on("data", (d) => (out += d));
  srv.stderr.on("data", (d) => (out += d));
  let ok = false;
  try {
    await sleep(1800);
    const pw = /temporary password: (\S+)/.exec(out)[1];
    let cookie = "";
    const call = async (m, u, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${u}`, {
        method: m,
        headers: { cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = r.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      return r.json();
    };
    await call("POST", "/api/login", { username: "admin", password: pw });
    await call("POST", "/api/change-password", {
      currentPassword: pw,
      newPassword: "legacy-check-pass-1",
    });
    await call("POST", "/api/login", { username: "admin", password: "legacy-check-pass-1" });
    const l1 = await call("GET", "/api/admin/devices");
    console.log(
      "legacy store loads, not re-imported:",
      /Device list +saved in the data folder/.test(out) && !/imported/.test(out),
    );
    console.log("spaces derived from screens:", JSON.stringify(l1.spaces));
    await call("POST", "/api/admin/devices/spaces", { name: "Gym" });
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, "devices.store.json"), "utf8"));
    console.log(
      "after the next change the store file carries spaces:",
      JSON.stringify(saved.spaces),
    );
    ok =
      JSON.stringify(l1.spaces) === JSON.stringify(["Space A", "Space B", "Space C"]) &&
      JSON.stringify(saved.spaces) === JSON.stringify(["Space A", "Space B", "Space C", "Gym"]);
  } catch (e) {
    console.log("ERROR", e.message, out.slice(-400));
  } finally {
    srv.kill();
    await sleep(300);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
})();
