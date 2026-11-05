// End-to-end check of TV power: scoping, permissions, error paths, retry, live changes, activity log.
import { spawn, fork } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP = path.join(__dirname, "..");
const DATA = path.join(os.tmpdir(), "switchboard-av-test-tvpower-data");
const PORT = 18084;
const SERIAL = "16752";
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
const results = [];
const check = (name, ok, extra) => results.push([name, !!ok, extra]);

function session() {
  let cookie = "";
  return async (url, body) => {
    const res = await fetch(base + url, {
      method:
        body === undefined ? "GET" : url.includes("/groups/") && body._patch ? "PATCH" : "POST",
      headers: { cookie, "content-type": "application/json" },
      body:
        body === undefined
          ? undefined
          : JSON.stringify(body._patch ? { ...body, _patch: undefined } : body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    let json;
    try {
      json = await res.json();
    } catch {
      json = null; // the body is not JSON
    }
    return { status: res.status, json };
  };
}

function mockIpc(mock, cmd, replyCmd) {
  return new Promise((resolve) => {
    const h = (m) => {
      if (m && m.cmd === replyCmd) {
        mock.off("message", h);
        resolve(m);
      }
    };
    mock.on("message", h);
    mock.send({ cmd });
  });
}

(async () => {
  try {
    if (!fs.existsSync(path.join(APP, "test", "devices.test.json")))
      throw new Error("no test devices file");
    const env = {
      ...process.env,
      DEVICES_FILE: path.join(APP, "test", "devices.test.json"),
      DATA_DIR: DATA,
      PORT: String(PORT),
      BIND: "127.0.0.1",
      TLS: "off",
      TV_SERIAL_PORT: SERIAL,
    };
    const mock = fork(path.join(APP, "test", "mock-decoders.js"), [], {
      cwd: APP,
      env,
      silent: true,
    });
    kids.push(mock);
    await new Promise((r) => mock.once("message", r)); // ready
    await sleep(300);

    let out = "";
    const srv = spawn(process.execPath, ["server.js"], { cwd: APP, env });
    kids.push(srv);
    srv.stdout.on("data", (d) => (out += d));
    srv.stderr.on("data", (d) => (out += d));
    await sleep(1500);
    if (!out.includes("devices.test.json"))
      throw new Error("server is not on the test devices file");
    check("startup logs TV power count (4 flagged)", / 4 with TV power/.test(out));
    const adminPw = /temporary password: (\S+)/.exec(out)[1];

    const admin = session();
    await admin("/api/login", { username: "admin", password: adminPw });
    await admin("/api/change-password", {
      currentPassword: adminPw,
      newPassword: "admin-test-pass-1",
    });
    await admin("/api/login", { username: "admin", password: "admin-test-pass-1" });

    const mkGroup = async (name, spaces, tvPower, extra = {}) =>
      (await admin("/api/admin/groups", { name, spaces, tvPower, sources: "all", ...extra })).json;
    const gPower = await mkGroup("Power crew", ["Space A", "Space B", "Space C"], true);
    const gNoPower = await mkGroup("Watchers", ["Space A"], false);
    const gAonly = await mkGroup("A power only", ["Space A"], true);
    check("group stores tvPower flag", gPower.tvPower === true && gNoPower.tvPower === false);

    const mkUser = async (username, groups) => {
      const u = (
        await admin("/api/admin/users", { name: username, username, role: "user", groups })
      ).json;
      const s = session();
      await s("/api/login", { username, password: u.tempPassword });
      await s("/api/change-password", {
        currentPassword: u.tempPassword,
        newPassword: `${username}-test-pass-1`,
      });
      await s("/api/login", { username, password: `${username}-test-pass-1` });
      return s;
    };
    const pwr = await mkUser("pwr", [gPower.id]);
    const nop = await mkUser("nop", [gNoPower.id]);
    const aonly = await mkUser("aonly", [gAonly.id]);

    const A1 = "127.0.1.11",
      A2 = "127.0.1.12",
      B1 = "127.0.1.21",
      B2 = "127.0.1.22",
      C1 = "127.0.1.31";
    const dec = (snap, ip) => snap.decoders.find((d) => d.ip === ip);

    // 1. snapshot flags
    let snap = (await pwr("/api/devices")).json;
    check(
      "power user: canPower true on A1, A2, B1, C1; false on B2 (not set up)",
      [A1, A2, B1, C1].every((ip) => dec(snap, ip).canPower) && dec(snap, B2).canPower === false,
    );
    snap = (await nop("/api/devices")).json;
    check(
      "non-power user: canPower false everywhere",
      snap.decoders.every((d) => d.canPower === false),
    );
    snap = (await aonly("/api/devices")).json;
    check(
      "A-only user sees only A and can power both",
      snap.decoders.length === 2 && snap.decoders.every((d) => d.canPower),
    );

    // 2. commands + mock side effects
    let r = await pwr("/api/tv-power", { decoderIp: A1, action: "off" });
    check(
      "off A1 -> 200, TV off",
      r.status === 200 && r.json.on === false,
      JSON.stringify(r.json && r.json.on),
    );
    let tv = await mockIpc(mock, "getTv", "tv");
    check(
      "mock TV A1 really off, got 'ka 00 00'",
      tv.tvOn[A1] === false && (tv.commands[A1] || []).includes("ka 00 00"),
    );
    check(
      "snapshot returned with the reply shows tvOn false",
      dec(r.json.snapshot, A1).tvOn === false,
    );
    r = await pwr("/api/tv-power", { decoderIp: A1, action: "on" });
    tv = await mockIpc(mock, "getTv", "tv");
    check(
      "on A1 -> 200, TV on, got 'ka 00 01'",
      r.status === 200 &&
        r.json.on === true &&
        tv.tvOn[A1] === true &&
        tv.commands[A1].includes("ka 00 01"),
    );
    r = await pwr("/api/tv-power", { decoderIp: A1, action: "status" });
    tv = await mockIpc(mock, "getTv", "tv");
    check(
      "status A1 -> on, sent 'ka 00 ff'",
      r.status === 200 && r.json.on === true && tv.commands[A1].includes("ka 00 ff"),
    );
    check("non-admin reply carries no raw serial text", r.json.raw === undefined);

    // 3. permission failures
    r = await nop("/api/tv-power", { decoderIp: A1, action: "off" });
    check("user without power tick -> 403", r.status === 403);
    tv = await mockIpc(mock, "getTv", "tv");
    check("...and the TV was not touched (last command still status)", tv.tvOn[A1] === true);
    r = await aonly("/api/tv-power", { decoderIp: C1, action: "off" });
    check("power user outside scope (C1) -> 403", r.status === 403);
    r = await pwr("/api/tv-power", { decoderIp: B2, action: "off" });
    check("screen not set up for TV power (B2) -> 400", r.status === 400);
    r = await pwr("/api/tv-power", { decoderIp: A1, action: "reboot" });
    check("bad action -> 400", r.status === 400);
    r = await pwr("/api/tv-power", { decoderIp: "9.9.9.9", action: "on" });
    check("unknown decoder IP -> 400", r.status === 400);
    r = await pwr("/api/tv-power", { decoderIp: B2, action: "status", probe: true });
    check("non-admin cannot use probe on an unflagged screen -> 400", r.status === 400);

    // 4. error paths (timed)
    let t0 = Date.now();
    r = await pwr("/api/tv-power", { decoderIp: B1, action: "on" });
    let dt = Date.now() - t0;
    check(
      "refused serial port (B1) -> 502 with plain message",
      r.status === 502 && /refused the serial connection/.test(r.json.error),
      r.json && r.json.error,
    );
    check(
      "...after exactly one retry (about 400 ms pause, well under 2 s)",
      dt >= 350 && dt < 2000,
      `${dt} ms`,
    );
    t0 = Date.now();
    r = await pwr("/api/tv-power", { decoderIp: C1, action: "on" });
    dt = Date.now() - t0;
    check(
      "silent TV (C1) -> 502 'No reply', two attempts (~5.4 s)",
      r.status === 502 && /No reply/.test(r.json.error) && dt > 5000 && dt < 7500,
      `${dt} ms: ${r.json && r.json.error}`,
    );

    // 5. admin
    r = await admin("/api/tv-power", { decoderIp: B2, action: "status", probe: true });
    check(
      "admin probe works on an unflagged screen and returns the raw reply",
      r.status === 200 && /OK0[01]x/.test(r.json.raw),
      JSON.stringify(r.json && r.json.raw),
    );
    r = await admin("/api/tv-power", { decoderIp: B2, action: "off" });
    check("admin cannot power an unflagged screen without probe -> 400", r.status === 400);
    snap = (await admin("/api/devices")).json;
    check(
      "admin canPower true on flagged, false on B2",
      dec(snap, A1).canPower && !dec(snap, B2).canPower,
    );

    // 6. permission changes apply to an already-open session
    await admin(`/api/admin/groups/${gPower.id}`, { tvPower: false, _patch: true });
    r = await pwr("/api/tv-power", { decoderIp: A1, action: "off" });
    check("unticking the group box blocks the open session immediately", r.status === 403);
    snap = (await pwr("/api/devices")).json;
    check(
      "...and canPower drops to false in its snapshot",
      snap.decoders.every((d) => d.canPower === false),
    );
    await admin(`/api/admin/groups/${gPower.id}`, { tvPower: true, _patch: true });
    r = await pwr("/api/tv-power", { decoderIp: A1, action: "status" });
    check("ticking it again restores access", r.status === 200);

    // 7. concurrent commands to one screen
    const [c1, c2] = await Promise.all([
      pwr("/api/tv-power", { decoderIp: A2, action: "off" }),
      pwr("/api/tv-power", { decoderIp: A2, action: "off" }),
    ]);
    const codes = [c1.status, c2.status].sort();
    check(
      "two simultaneous commands: none crash; busy guard rejects the second when they overlap",
      codes[0] === 200 &&
        (codes[1] === 200 ||
          (codes[1] === 502 && /already running/.test((c1.status === 502 ? c1 : c2).json.error))),
      `${codes}`,
    );

    // 8. activity log
    const act = (await admin("/api/admin/activity")).json.filter((e) => e.type === "tv_power");
    check(
      "activity has tv_power entries for on/off/failures/probe",
      act.some((e) => e.action === "off" && e.result === "TV off") &&
        act.some((e) => e.action === "on") &&
        act.some((e) => /failed/.test(e.result)) &&
        act.some((e) => e.action === "probe"),
    );
    check("routine status checks are not logged", !act.some((e) => e.action === "status"));
    check(
      "log entries carry who did it",
      act.every((e) => e.username),
    );

    // 9. the sample devices.json that comes with the app
    const sample = JSON.parse(fs.readFileSync(path.join(APP, "devices.json"), "utf8"));
    const docRange = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;
    const everyDevice = [...sample.decoders, ...sample.encoders];
    const sampleIps = everyDevice.map((d) => d.ip);
    check(
      "the sample devices.json has screens and sources, all on documentation-only addresses (it can never reach real equipment)",
      sample.decoders.length > 0 &&
        sample.encoders.length > 0 &&
        sampleIps.every((ip) => docRange.test(ip)),
      sampleIps.filter((ip) => !docRange.test(ip)).join(","),
    );
    check(
      "...no address is used twice and every entry has a name",
      new Set(sampleIps).size === sampleIps.length &&
        everyDevice.every((d) => typeof d.name === "string" && d.name.length > 0),
    );
    check(
      "...TV power is only ever lg, and source inputs are valid choices",
      sample.decoders.every((d) => !d.tvPower || d.tvPower === "lg") &&
        sample.encoders.every(
          (e) =>
            !e.inputs || e.inputs.every((v) => ["HDMI1", "HDMI2", "USB-C", "AUTO"].includes(v)),
        ),
    );
    check(
      "...it flags two screens for LG TV power, as an example",
      sample.decoders.filter((d) => d.tvPower === "lg").length === 2,
    );
  } catch (e) {
    check("HARNESS ERROR: " + e.message, false);
  } finally {
    for (const k of kids)
      try {
        k.kill();
      } catch (err) {
        console.log(`could not stop a child process: ${err.message}`);
      }
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  let pass = 0;
  for (const [name, ok, extra] of results) {
    console.log(ok ? "PASS" : "FAIL", name, extra ? `  [${extra}]` : "");
    if (ok) pass++;
  }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
