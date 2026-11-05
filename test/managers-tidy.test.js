// A store saved before demotion removed managers automatically may hold stale manager names.
// On the next start they must be tidied, once, and the tidy logged.
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, "..");
const DATA = path.join(os.tmpdir(), "switchboard-av-test-tidy-data");
const PORT = 18099;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = {
  ...process.env,
  DEVICES_FILE: path.join(APP, "test", "devices.test.json"),
  DATA_DIR: DATA,
  PORT: String(PORT),
  BIND: "127.0.0.1",
  TLS: "off",
};

function run() {
  const srv = spawn(process.execPath, ["server.js"], { cwd: APP, env });
  let out = "";
  srv.stdout.on("data", (d) => (out += d));
  srv.stderr.on("data", (d) => (out += d));
  return { srv, out: () => out };
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  let ok = false;
  let a, b;
  try {
    a = run(); // first start: creates the admin account
    await sleep(1500);
    a.srv.kill();
    await sleep(500);
    const file = path.join(DATA, "store.json");
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    const admin = Object.values(store.users)[0];
    // a group whose managers are: a name that never existed, and an admin (not a Manager)
    store.groups.g_test = {
      id: "g_test",
      name: "Old group",
      spaces: [],
      decoders: [],
      excludeDecoders: [],
      sources: [],
      managers: ["ghost", admin.username],
    };
    fs.writeFileSync(file, JSON.stringify(store));
    b = run();
    await sleep(1500);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    const act = JSON.parse(fs.readFileSync(path.join(DATA, "activity.json"), "utf8"));
    const tidied = JSON.stringify(after.groups.g_test.managers) === "[]";
    const logged = act.some(
      (e) => e.by === "system" && /no longer hold the Manager role/.test(e.detail || ""),
    );
    console.log("stale managers removed on start:", tidied);
    console.log("tidy recorded in Activity:", logged);
    // a second start changes nothing further
    b.srv.kill();
    await sleep(500);
    const c = run();
    await sleep(1500);
    c.srv.kill();
    await sleep(300);
    const act2 = JSON.parse(fs.readFileSync(path.join(DATA, "activity.json"), "utf8"));
    const once = act2.filter((e) => e.by === "system").length === 1;
    console.log("tidy happens only once:", once);
    ok = tidied && logged && once;
  } catch (e) {
    console.log("ERROR", e.message);
  } finally {
    for (const p of [a, b])
      try {
        p && p.srv.kill();
      } catch (err) {
        console.log(`could not stop a child process: ${err.message}`);
      }
    await sleep(300);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
})();
