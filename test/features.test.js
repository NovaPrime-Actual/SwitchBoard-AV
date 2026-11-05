// End-to-end checks for the four new features against the 127.x mock decoders (never real devices).
// Sections are run in order; pass a name (route | status | screen | input) to run only up to that section.
import { spawn, fork } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP = path.join(__dirname, "..");
const DATA = path.join(os.tmpdir(), "switchboard-av-test-features-data");
const PORT = 18092;
const SERIAL = "16755";
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
const results = [];
const check = (name, ok, extra) => results.push([name, !!ok, extra]);
const only = process.argv[2] || "all";
const want = (s) => only === "all" || only === s;

function session() {
  let cookie = "";
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
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

const env = () => ({
  ...process.env,
  DEVICES_FILE: path.join(APP, "test", "devices.test.json"),
  DATA_DIR: DATA,
  PORT: String(PORT),
  BIND: "127.0.0.1",
  TLS: "off",
  TV_SERIAL_PORT: SERIAL,
  STATUS_POLL_SECONDS: "7",
});
let out = "";
let mock;
const ipc = (cmd, reply) =>
  new Promise((resolve) => {
    const h = (m) => {
      if (m && m.cmd === reply) {
        mock.off("message", h);
        resolve(m);
      }
    };
    mock.on("message", h);
    mock.send({ cmd });
  });

const A1 = "127.0.1.11",
  A2 = "127.0.1.12",
  B1 = "127.0.1.21",
  B2 = "127.0.1.22",
  C1 = "127.0.1.31";
const S1 = "127.0.2.11",
  S2 = "127.0.2.12",
  S3 = "127.0.2.13";

(async () => {
  try {
    mock = fork(path.join(APP, "test", "mock-decoders.js"), [], {
      cwd: APP,
      env: env(),
      silent: true,
    });
    kids.push(mock);
    await new Promise((r) => mock.once("message", r));
    await sleep(300);
    const srv = spawn(process.execPath, ["server.js"], { cwd: APP, env: env() });
    kids.push(srv);
    srv.stdout.on("data", (d) => (out += d));
    srv.stderr.on("data", (d) => (out += d));
    await sleep(1500);
    if (!out.includes("devices.test.json")) throw new Error("server not on the test devices file");
    const adminPw = /temporary password: (\S+)/.exec(out)[1];

    const admin = session();
    await admin("POST", "/api/login", { username: "admin", password: adminPw });
    await admin("POST", "/api/change-password", {
      currentPassword: adminPw,
      newPassword: "admin-test-pass-1",
    });
    await admin("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
    const mkGroup = async (g) => (await admin("POST", "/api/admin/groups", g)).json;
    const mkUser = async (username, groups) => {
      const u = (
        await admin("POST", "/api/admin/users", { name: username, username, role: "user", groups })
      ).json;
      const s = session();
      await s("POST", "/api/login", { username, password: u.tempPassword });
      await s("POST", "/api/change-password", {
        currentPassword: u.tempPassword,
        newPassword: `${username}-test-pass-1`,
      });
      await s("POST", "/api/login", { username, password: `${username}-test-pass-1` });
      return s;
    };
    const gAll = await mkGroup({
      name: "All",
      spaces: ["Space A", "Space B", "Space C"],
      sources: "all",
      multiSwitch: true,
    });
    const gA = await mkGroup({
      name: "A only",
      spaces: ["Space A"],
      sources: [S1, S2],
      multiSwitch: true,
    });
    const all = await mkUser("allu", [gAll.id]);
    const aonly = await mkUser("aonly", [gA.id]);
    const tuned = async () => (await ipc("getState", "state")).state;

    // ====================================================================== 1. several screens at once
    if (want("route")) {
      let r = await all("POST", "/api/route", { decoderIps: [A1, A2, B1], encoderIp: S1 });
      let st = await tuned();
      check(
        "batch of 3 -> 200, every screen confirmed, one result each",
        r.status === 200 &&
          r.json.confirmed === true &&
          r.json.results.length === 3 &&
          r.json.results.every((x) => x.confirmed),
        JSON.stringify(r.json && r.json.results),
      );
      check(
        "...and all three decoders really are tuned to Source 1",
        st[A1] === S1 && st[A2] === S1 && st[B1] === S1,
        JSON.stringify(st),
      );
      check(
        "reply carries a fresh snapshot with the new sources",
        r.json.snapshot.decoders.find((d) => d.ip === B1).host === S1,
      );

      // ---- "select several" is a group permission (off by default)
      const gNoMulti = await mkGroup({
        name: "No multi",
        spaces: ["Space A", "Space B", "Space C"],
        sources: "all",
        screenControl: true,
      });
      check(
        "a new group has multiSwitch off by default",
        gNoMulti.multiSwitch === false && gAll.multiSwitch === true,
      );
      const nom = await mkUser("nom", [gNoMulti.id]);
      r = await nom("GET", "/api/devices");
      check(
        "snapshot: canMulti false on every screen without the tick",
        r.json.decoders.every((d) => d.canMulti === false),
      );
      r = await all("GET", "/api/devices");
      check(
        "snapshot: canMulti true everywhere for a ticked group",
        r.json.decoders.every((d) => d.canMulti === true),
      );
      r = await admin("GET", "/api/devices");
      check(
        "admin: canMulti true everywhere",
        r.json.decoders.every((d) => d.canMulti === true),
      );
      st = await tuned();
      r = await nom("POST", "/api/route", { decoderIps: [A1, A2], encoderIp: S3 });
      check(
        "no tick: switching two screens together -> 403 with a clear message",
        r.status === 403 && /several screens at once/.test(r.json.error),
        r.json && r.json.error,
      );
      check("...and nothing was switched", JSON.stringify(await tuned()) === JSON.stringify(st));
      r = await nom("POST", "/api/route", { decoderIps: [A1], encoderIp: S3 });
      check(
        "no tick: a list of one screen still works",
        r.status === 200 && r.json.confirmed === true,
      );
      r = await nom("POST", "/api/route", { decoderIp: A2, encoderIp: S3 });
      check(
        "no tick: single-screen switching is unaffected",
        r.status === 200 && r.json.confirmed === true,
      );
      r = await nom("POST", "/api/screen", { decoderIps: [A1, A2], action: "black" });
      check(
        "no tick: blanking two screens together -> 403 too",
        r.status === 403 && /several screens at once/.test(r.json.error),
        r.json && r.json.error,
      );
      r = await nom("POST", "/api/screen", { decoderIp: A1, action: "picture" });
      check("no tick: blanking one screen is unaffected", r.status === 200 && r.json.ok === true);
      await admin("PATCH", `/api/admin/groups/${gNoMulti.id}`, { multiSwitch: true });
      r = await nom("POST", "/api/route", { decoderIps: [A1, A2], encoderIp: S1 });
      check(
        "ticking the group box lets the open session switch several at once",
        r.status === 200 && r.json.confirmed === true && r.json.results.length === 2,
      );
      await admin("PATCH", `/api/admin/groups/${gNoMulti.id}`, { multiSwitch: false });
      r = await nom("POST", "/api/route", { decoderIps: [A1, A2], encoderIp: S1 });
      check("unticking it blocks it again at once", r.status === 403);
      r = await admin("POST", "/api/route", { decoderIps: [A1, A2], encoderIp: S1 });
      check("admin can always switch several", r.status === 200 && r.json.results.length === 2);

      // two groups: multi on for Space A only
      const gMa = await mkGroup({
        name: "Multi in A",
        spaces: ["Space A"],
        sources: "all",
        multiSwitch: true,
      });
      const gSb = await mkGroup({ name: "Single in B", spaces: ["Space B"], sources: "all" });
      const mix = await mkUser("mix", [gMa.id, gSb.id]);
      r = await mix("GET", "/api/devices");
      check(
        "snapshot: canMulti follows the group that grants the screen (A yes, B no)",
        r.json.decoders.filter((d) => d.space === "Space A").every((d) => d.canMulti) &&
          r.json.decoders.filter((d) => d.space === "Space B").every((d) => !d.canMulti),
      );
      r = await mix("POST", "/api/route", { decoderIps: [A1, A2], encoderIp: S1 });
      check("two screens in the multi group -> ok", r.status === 200);
      r = await mix("POST", "/api/route", { decoderIps: [A1, B1], encoderIp: S1 });
      check(
        "one screen from the non-multi group in the mix -> 403",
        r.status === 403 && /several screens at once/.test(r.json.error),
      );
      r = await mix("POST", "/api/route", { decoderIp: B1, encoderIp: S1 });
      check("...but that screen on its own is fine", r.status === 200);

      r = await all("POST", "/api/route", { decoderIp: A1, encoderIp: S2 });
      st = await tuned();
      check(
        "single-screen request still works (decoderIp) and returns results[0]",
        r.status === 200 &&
          r.json.confirmed === true &&
          r.json.results.length === 1 &&
          r.json.host === S2 &&
          st[A1] === S2,
      );

      r = await aonly("POST", "/api/route", { decoderIps: [A1, B2], encoderIp: S1 });
      st = await tuned();
      check(
        "one screen outside the user's access -> 403 for the whole batch",
        r.status === 403 && /outside your access/.test(r.json.error),
        r.json && r.json.error,
      );
      check("...and nothing was switched (A1 still on Source 2)", st[A1] === S2 && !st[B2]);
      r = await aonly("POST", "/api/route", { decoderIps: [A1, A2], encoderIp: S3 });
      check(
        "source outside the user's access -> 403",
        r.status === 403 && /source is outside/.test(r.json.error),
      );
      r = await aonly("POST", "/api/route", { decoderIps: [A1, A2], encoderIp: S1 });
      check(
        "user switches both screens in their own space",
        r.status === 200 && r.json.confirmed === true && r.json.results.length === 2,
      );

      r = await all("POST", "/api/route", { decoderIps: [], encoderIp: S1 });
      check("empty list -> 400", r.status === 400);
      r = await all("POST", "/api/route", {
        decoderIps: Array.from({ length: 101 }, (_, i) => `127.0.9.${i + 1}`),
        encoderIp: S1,
      });
      check("more than 100 screens -> 400", r.status === 400 && /at most 100/.test(r.json.error));
      r = await all("POST", "/api/route", { decoderIps: [A1, "127.0.9.9"], encoderIp: S1 });
      check("unknown screen in the list -> 400", r.status === 400);
      r = await all("POST", "/api/route", { decoderIps: [A1, A1, A1], encoderIp: S3 });
      check(
        "repeated screen is switched once (de-duplicated)",
        r.status === 200 && r.json.results.length === 1,
      );

      const t0 = Date.now();
      r = await all("POST", "/api/route", { decoderIps: [A1, C1], encoderIp: S1 });
      check(
        "a screen that doesn't confirm -> overall confirmed false, per-screen detail",
        r.status === 200 &&
          r.json.confirmed === false &&
          r.json.results.find((x) => x.decoderIp === A1).confirmed === true &&
          r.json.results.find((x) => x.decoderIp === C1).confirmed === false,
        JSON.stringify(r.json && r.json.results),
      );
      check(
        "...and the good screen is not held back by the bad one",
        r.json.results.find((x) => x.decoderIp === A1).confirmed === true,
        `${Date.now() - t0} ms`,
      );

      const [p1, p2] = await Promise.all([
        all("POST", "/api/route", { decoderIps: [A2, B1], encoderIp: S1 }),
        all("POST", "/api/route", { decoderIps: [A2, B2], encoderIp: S1 }),
      ]);
      const errs = [...p1.json.results, ...p2.json.results].filter((x) => x.error);
      check(
        "two overlapping batches on one screen: no crash; the busy guard reports it",
        p1.status === 200 &&
          p2.status === 200 &&
          (errs.length === 0 || errs.every((e) => /already in progress/.test(e.error))),
        JSON.stringify(errs),
      );

      const act = (await admin("GET", "/api/admin/activity")).json.filter(
        (e) => e.type === "route",
      );
      check(
        "activity: one entry per screen, batch size recorded",
        act.some((e) => e.batch === 3 && e.decoderIp === B1) &&
          act.some((e) => !("batch" in e) && e.decoderIp === A1),
      );
      check(
        "activity: the failed screen is logged as not confirmed",
        act.some((e) => e.decoderIp === C1 && e.result === "not confirmed"),
      );
    }
    // ====================================================================== 2. live status + health view
    if (want("status")) {
      let r = await all("GET", "/api/devices");
      check(
        "snapshot carries the poll interval (STATUS_POLL_SECONDS=7)",
        r.json.pollSeconds === 7,
        String(r.json.pollSeconds),
      );
      r = await admin("GET", "/api/admin/health");
      check(
        "health report before a check: 5 screens + 3 sources, nothing probed yet",
        r.status === 200 &&
          r.json.devices.length === 8 &&
          r.json.devices.filter((d) => d.kind === "decoder").length === 5 &&
          r.json.devices.filter((d) => d.kind === "encoder").length === 3 &&
          r.json.devices.every((d) => d.model === null),
      );
      r = await all("GET", "/api/admin/health");
      check("a plain user cannot read the health report (403)", r.status === 403);
      r = await all("POST", "/api/admin/health/check");
      check("a plain user cannot start a check (403)", r.status === 403);

      const t0 = Date.now();
      const [c1, c2] = await Promise.all([
        admin("POST", "/api/admin/health/check"),
        admin("POST", "/api/admin/health/check"),
      ]);
      const dt = Date.now() - t0;
      check(
        "two simultaneous checks share one run (same checkedAt)",
        c1.status === 200 &&
          c2.status === 200 &&
          c1.json.checkedAt === c2.json.checkedAt &&
          c1.json.checkedAt > t0 - 5,
      );
      check(
        "the check runs devices in parallel (8 devices, 2 silent, well under 4 s)",
        dt < 4000,
        `${dt} ms`,
      );
      const row = (ip) => c1.json.devices.find((d) => d.ip === ip);
      check(
        "answering screens: reachable, model D5200, real round-trip time",
        [A1, A2, B1, B2].every(
          (ip) =>
            row(ip).reachable === true &&
            row(ip).model === "D5200" &&
            typeof row(ip).ms === "number" &&
            row(ip).ms < 800,
        ),
        JSON.stringify(row(A1)),
      );
      check(
        "offline screen C1: not reachable, no model, no time",
        row(C1).reachable === false && row(C1).model === null && row(C1).ms === null,
      );
      check(
        "sources: Source 1 and 2 answer with model E5200; the offline Source 3 is listed as not reachable",
        row(S1).reachable === true &&
          row(S1).model === "E5200" &&
          row(S2).reachable === true &&
          row(S3).reachable === false,
        JSON.stringify([row(S1), row(S3)]),
      );
      check(
        "summary counts add up (6 answering, 2 not, 0 unknown)",
        c1.json.summary.total === 8 &&
          c1.json.summary.answering === 6 &&
          c1.json.summary.notAnswering === 2 &&
          c1.json.summary.unknown === 0,
        JSON.stringify(c1.json.summary),
      );
      check(
        "screens carry their space; last reply time recorded",
        row(A1).space === "Space A" && row(A1).lastReply > t0 - 5,
      );
      if (only === "all")
        check(
          "a screen's current source is named (A1 was routed earlier)",
          typeof row(A1).source === "string",
          JSON.stringify(row(A1).source),
        );
      r = await all("GET", "/api/devices");
      check(
        "the check also fed the normal page: C1 now shows no response, A1 reachable",
        r.json.decoders.find((d) => d.ip === C1).reachable === false &&
          r.json.decoders.find((d) => d.ip === A1).reachable === true,
      );

      // a device removed in Devices disappears from the report and caches
      await admin("POST", "/api/admin/devices/decoders", {
        name: "Tmp",
        space: "Space A",
        ip: "127.0.1.99",
      });
      r = await admin("GET", "/api/admin/health");
      check(
        "a newly added screen shows up as never probed",
        r.json.devices.length === 9 &&
          r.json.devices.find((d) => d.ip === "127.0.1.99").reachable === null,
      );
      await admin("DELETE", "/api/admin/devices/decoders/127.0.1.99");
      r = await admin("GET", "/api/admin/health");
      check(
        "...and is gone again after it is deleted",
        r.json.devices.length === 8 && !r.json.devices.some((d) => d.ip === "127.0.1.99"),
      );

      // ---- a Manager's Status covers only the screens and sources of the groups they manage
      const mgrUser = (
        await admin("POST", "/api/admin/users", {
          name: "Mgr Status",
          username: "mgrs",
          role: "manager",
          groups: [],
        })
      ).json;
      const mgr = session();
      await mgr("POST", "/api/login", { username: "mgrs", password: mgrUser.tempPassword });
      await mgr("POST", "/api/change-password", {
        currentPassword: mgrUser.tempPassword,
        newPassword: "mgrs-test-pass-1",
      });
      await mgr("POST", "/api/login", { username: "mgrs", password: "mgrs-test-pass-1" });
      const mgrNone = (
        await admin("POST", "/api/admin/users", {
          name: "Mgr None",
          username: "mgrn",
          role: "manager",
          groups: [],
        })
      ).json;
      const mgr0 = session();
      await mgr0("POST", "/api/login", { username: "mgrn", password: mgrNone.tempPassword });
      await mgr0("POST", "/api/change-password", {
        currentPassword: mgrNone.tempPassword,
        newPassword: "mgrn-test-pass-1",
      });
      await mgr0("POST", "/api/login", { username: "mgrn", password: "mgrn-test-pass-1" });
      await admin("POST", "/api/admin/groups", {
        name: "Managed by mgrs",
        spaces: ["Space A"],
        sources: [S1],
        managers: ["mgrs"],
      });
      await admin("POST", "/api/admin/groups", {
        name: "Not managed by mgrs",
        spaces: ["Space B"],
        sources: [S2],
      });

      r = await mgr0("GET", "/api/admin/health");
      check(
        "a Manager who manages no group sees an empty report",
        r.status === 200 && r.json.devices.length === 0 && r.json.summary.total === 0,
      );
      r = await mgr("GET", "/api/admin/health");
      const ips = r.json.devices.map((d) => d.ip).sort();
      check(
        "a Manager's report covers their group's screens and sources only",
        r.status === 200 && JSON.stringify(ips) === JSON.stringify([A1, A2, S1].sort()),
        JSON.stringify(ips),
      );
      check("...with a summary for just those three", r.json.summary.total === 3);

      const before = (await admin("GET", "/api/admin/health")).json.devices;
      const at = (ip) => before.find((d) => d.ip === ip).checkedAt;
      await sleep(30);
      r = await mgr("POST", "/api/admin/health/check");
      const after = (await admin("GET", "/api/admin/health")).json.devices;
      const at2 = (ip) => after.find((d) => d.ip === ip).checkedAt;
      check(
        "a Manager's check refreshes their devices (A1, A2, Source 1)",
        [A1, A2, S1].every((ip) => at2(ip) > at(ip)),
        JSON.stringify([A1, at(A1), at2(A1)]),
      );
      check(
        "...and does not touch anyone else's (B1, B2, C1, Source 2, Source 3 unchanged)",
        [B1, B2, C1, S2, S3].every((ip) => at2(ip) === at(ip)),
      );
      check(
        "the Manager's rows carry model, speed and what each screen shows",
        r.json.devices.find((d) => d.ip === A1).model === "D5200" &&
          typeof r.json.devices.find((d) => d.ip === A1).ms === "number" &&
          r.json.devices.find((d) => d.ip === S1).model === "E5200",
      );
      r = await mgr("POST", "/api/admin/health/check");
      check("running it again is fine", r.status === 200 && r.json.devices.length === 3);
      r = await mgr0("POST", "/api/admin/health/check");
      check(
        "a Manager with nothing to manage: check returns an empty report, no error",
        r.status === 200 && r.json.devices.length === 0,
      );
      r = await mgr("GET", "/api/admin/devices");
      check("a Manager still cannot read the device list (403)", r.status === 403);
    }
    // ====================================================================== 3. blank screen + on-screen message
    if (want("screen")) {
      const gScr = await mkGroup({
        name: "Screen crew",
        spaces: ["Space A", "Space B"],
        sources: "all",
        screenControl: true,
        multiSwitch: true,
      });
      const scr = await mkUser("scr", [gScr.id]);
      const screen = async () => ipc("getScreen", "screen");
      check("group stores the screenControl flag", gScr.screenControl === true);

      let r = await scr("GET", "/api/devices");
      check(
        "snapshot: canScreen true on the group's screens",
        r.json.decoders.length === 4 && r.json.decoders.every((d) => d.canScreen === true),
      );
      r = await all("GET", "/api/devices");
      check(
        "a group without the tick: canScreen false everywhere",
        r.json.decoders.every((d) => d.canScreen === false),
      );

      r = await scr("POST", "/api/screen", { decoderIp: A1, action: "black" });
      let st = await screen();
      check(
        "black -> confirmed, decoder really is in STANDBY",
        r.status === 200 && r.json.ok === true && st.output[A1] === "STANDBY",
        JSON.stringify(r.json && r.json.results),
      );
      check(
        "snapshot in the reply shows the screen as blank (STANDBY)",
        r.json.snapshot.decoders.find((d) => d.ip === A1).output === "STANDBY",
      );
      r = await scr("POST", "/api/screen", { decoderIp: A1, action: "status" });
      check(
        "status reads the mode back without changing it",
        r.status === 200 && r.json.results[0].output === "STANDBY",
      );
      r = await scr("POST", "/api/screen", { decoderIp: A1, action: "picture" });
      st = await screen();
      check("picture -> NORMAL again", r.json.ok === true && st.output[A1] === "NORMAL");
      r = await scr("POST", "/api/screen", { decoderIps: [A1, A2, B1], action: "black" });
      st = await screen();
      check(
        "batch black on 3 screens -> all confirmed, all STANDBY",
        r.json.ok === true &&
          r.json.results.length === 3 &&
          [A1, A2, B1].every((ip) => st.output[ip] === "STANDBY"),
      );
      r = await scr("POST", "/api/screen", { decoderIps: [A1, A2, B1], action: "logo" });
      st = await screen();
      check(
        "logo -> LOGO on all three",
        r.json.ok === true && [A1, A2, B1].every((ip) => st.output[ip] === "LOGO"),
      );

      r = await scr("POST", "/api/screen", {
        decoderIp: A1,
        action: "message",
        text: "Pool closes in 10 minutes",
      });
      st = await screen();
      check(
        "message -> confirmed by reading it back; decoder holds the text",
        r.status === 200 && r.json.ok === true && st.osd[A1] === "Pool closes in 10 minutes",
        JSON.stringify(st.osd[A1]),
      );
      r = await scr("POST", "/api/screen", { decoderIps: [A1, B1], action: "clear-message" });
      st = await screen();
      check(
        "clear-message -> confirmed empty on both",
        r.json.ok === true && st.osd[A1] === "" && st.osd[B1] === "",
      );

      r = await scr("POST", "/api/screen", {
        decoderIp: A1,
        action: "message",
        text: "x&VIDEO.OUTPUT=OFF",
      });
      st = await screen();
      check(
        "text with & or = is refused (cannot add a second command)",
        r.status === 400 && st.output[A1] !== "OFF",
        r.json && r.json.error,
      );
      r = await scr("POST", "/api/screen", {
        decoderIp: A1,
        action: "message",
        text: "y".repeat(81),
      });
      check("81-character message -> 400", r.status === 400);
      r = await scr("POST", "/api/screen", { decoderIp: A1, action: "message", text: "   " });
      check("empty message -> 400", r.status === 400);
      r = await scr("POST", "/api/screen", { decoderIp: A1, action: "reboot" });
      check("unknown action -> 400", r.status === 400);
      r = await scr("POST", "/api/screen", { decoderIps: [A1, A2], action: "status" });
      check("status for two screens at once -> 400", r.status === 400);
      r = await scr("POST", "/api/screen", { decoderIp: "127.0.9.9", action: "black" });
      check("unknown screen -> 400", r.status === 400);

      // permissions
      r = await all("POST", "/api/screen", { decoderIp: A1, action: "black" });
      st = await screen();
      check(
        "no screen-control tick -> 403, nothing sent",
        r.status === 403 && /screen control/.test(r.json.error) && st.output[A1] === "LOGO",
        r.json && r.json.error,
      );
      r = await scr("POST", "/api/screen", { decoderIps: [A1, C1], action: "black" });
      st = await screen();
      check(
        "one screen outside access -> 403 for the whole batch, A1 untouched",
        r.status === 403 && st.output[A1] === "LOGO",
      );
      r = await aonly("POST", "/api/screen", { decoderIp: A1, action: "black" });
      check("a plain user (no tick) is refused too", r.status === 403);
      r = await admin("POST", "/api/screen", { decoderIp: B2, action: "black" });
      st = await screen();
      check(
        "admin can use it on any screen",
        r.status === 200 && r.json.ok === true && st.output[B2] === "STANDBY",
      );

      // routing resets blanking (as the decoder does)
      await scr("POST", "/api/screen", { decoderIp: A1, action: "black" });
      r = await scr("POST", "/api/route", { decoderIp: A1, encoderIp: S1 });
      st = await screen();
      check(
        "switching source brings the picture back (mock and tile state)",
        r.json.confirmed === true &&
          st.output[A1] === "NORMAL" &&
          r.json.snapshot.decoders.find((d) => d.ip === A1).output === "NORMAL",
      );

      // refresh reads the output mode: someone else blanks B1
      mock.send({ cmd: "setOutput", ip: B1, value: "STANDBY" });
      await sleep(100);
      r = await all("POST", "/api/refresh", {});
      check(
        "refresh notices a screen blanked by someone else",
        r.json.decoders.find((d) => d.ip === B1).output === "STANDBY",
      );

      // offline screen
      const t0 = Date.now();
      r = await admin("POST", "/api/screen", { decoderIp: C1, action: "black" });
      check(
        "a screen that does not answer -> not confirmed (two attempts)",
        r.status === 200 &&
          r.json.ok === false &&
          r.json.results[0].ok === false &&
          Date.now() - t0 > 2500,
        `${Date.now() - t0} ms`,
      );

      // live permission change
      await admin("PATCH", `/api/admin/groups/${gScr.id}`, { screenControl: false });
      r = await scr("POST", "/api/screen", { decoderIp: A1, action: "black" });
      check("unticking the group box blocks the open session at once", r.status === 403);
      r = await scr("GET", "/api/devices");
      check(
        "...and canScreen drops to false in its snapshot",
        r.json.decoders.every((d) => d.canScreen === false),
      );
      await admin("PATCH", `/api/admin/groups/${gScr.id}`, { screenControl: true });

      const act = (await admin("GET", "/api/admin/activity")).json.filter(
        (e) => e.type === "screen",
      );
      check(
        "activity: actions, message text and batch size recorded; status checks not logged",
        act.some((e) => e.action === "black" && e.batch === 3) &&
          act.some((e) => e.action === "message" && e.text === "Pool closes in 10 minutes") &&
          act.some((e) => e.action === "black" && e.result === "not confirmed") &&
          !act.some((e) => e.action === "status"),
      );
    }
    // ====================================================================== 4. encoder input switching
    if (want("input")) {
      const gIn = await mkGroup({
        name: "Input crew",
        spaces: ["Space A"],
        sources: [S1, S2],
        inputControl: true,
      });
      const gIn2 = await mkGroup({
        name: "Input crew S1",
        spaces: ["Space A"],
        sources: [S1],
        inputControl: true,
      });
      const inu = await mkUser("inu", [gIn.id]);
      const inu2 = await mkUser("inu2", [gIn2.id]);
      const inputs = async () => (await ipc("getInput", "input")).inputs;
      check("group stores the inputControl flag", gIn.inputControl === true);

      let r = await inu("GET", "/api/devices");
      const src = (snap, ip) => snap.sources.find((s) => s.ip === ip);
      check(
        "snapshot: Source 1 and 2 offer inputs to the ticked group; Source 3 is not even visible",
        src(r.json, S1).canInput === true &&
          JSON.stringify(src(r.json, S1).inputs) ===
            JSON.stringify(["HDMI1", "HDMI2", "USB-C", "AUTO"]) &&
          JSON.stringify(src(r.json, S2).inputs) === JSON.stringify(["HDMI1", "HDMI2"]) &&
          !src(r.json, S3),
        JSON.stringify(r.json.sources),
      );
      r = await all("GET", "/api/devices");
      check(
        "a group without the tick: canInput false, no inputs listed",
        r.json.sources.every((s) => s.canInput === false && s.inputs.length === 0),
      );

      r = await inu("POST", "/api/source-input", { encoderIp: S1 });
      check(
        "read the current input (no change, no log entry)",
        r.status === 200 && r.json.ok === true && r.json.input === "HDMI1",
        JSON.stringify(r.json && r.json.input),
      );
      r = await inu("POST", "/api/source-input", { encoderIp: S1, input: "HDMI2" });
      let st = await inputs();
      check(
        "change to HDMI2 -> confirmed, the encoder really switched",
        r.status === 200 && r.json.ok === true && r.json.input === "HDMI2" && st[S1] === "HDMI2",
      );
      check(
        "the snapshot in the reply shows the new input",
        src(r.json.snapshot, S1).input === "HDMI2",
      );
      r = await inu("POST", "/api/source-input", { encoderIp: S1, input: "USB-C" });
      st = await inputs();
      check("USB-C (with the hyphen) works", r.json.ok === true && st[S1] === "USB-C");
      r = await inu("POST", "/api/source-input", { encoderIp: S1, input: "AUTO" });
      st = await inputs();
      check("AUTO works", r.json.ok === true && st[S1] === "AUTO");

      let t0 = Date.now();
      r = await inu("POST", "/api/source-input", { encoderIp: S2, input: "HDMI2" });
      check(
        "an encoder that acknowledges but does not switch -> not confirmed, reports what it is on",
        r.status === 200 &&
          r.json.ok === false &&
          r.json.input === "HDMI1" &&
          Date.now() - t0 > 1800,
        `${Date.now() - t0} ms ${JSON.stringify(r.json && r.json.input)}`,
      );
      r = await inu("POST", "/api/source-input", { encoderIp: S2, input: "USB-C" });
      check(
        "an input the encoder isn't set up to offer -> 400",
        r.status === 400 && /isn't offered/.test(r.json.error),
      );
      r = await admin("POST", "/api/source-input", { encoderIp: S3, input: "HDMI1" });
      check(
        "an encoder with no inputs set up -> 400",
        r.status === 400 && /isn't set up/.test(r.json.error),
      );
      r = await inu("POST", "/api/source-input", { encoderIp: "127.0.9.9", input: "HDMI1" });
      check("unknown source -> 400", r.status === 400);
      r = await inu("POST", "/api/source-input", "{nope");
      check("malformed body -> 400", r.status === 400);

      // permissions
      st = await inputs();
      r = await all("POST", "/api/source-input", { encoderIp: S1, input: "HDMI1" });
      check(
        "no input-control tick -> 403 and nothing changes",
        r.status === 403 && /input control/.test(r.json.error) && (await inputs())[S1] === st[S1],
        r.json && r.json.error,
      );
      r = await inu2("POST", "/api/source-input", { encoderIp: S2, input: "HDMI2" });
      check(
        "a source outside the group's sources -> 403",
        r.status === 403 && /outside your access/.test(r.json.error),
      );
      r = await aonly("POST", "/api/source-input", { encoderIp: S1, input: "HDMI1" });
      check("a plain user is refused", r.status === 403);
      r = await admin("POST", "/api/source-input", { encoderIp: S1, input: "HDMI1" });
      check(
        "admin can change any set-up encoder",
        r.status === 200 && r.json.ok === true && (await inputs())[S1] === "HDMI1",
      );

      // setting up inputs through the Devices API
      r = await admin("PATCH", "/api/admin/devices/encoders/" + S3, { inputs: ["HDMI9"] });
      check(
        "Devices API: an unknown input value -> 400",
        r.status === 400 && /Unknown input/.test(r.json.error),
        r.json && r.json.error,
      );
      r = await admin("PATCH", "/api/admin/devices/encoders/" + S3, { inputs: "HDMI1" });
      check("Devices API: inputs must be a list -> 400", r.status === 400);
      r = await admin("PATCH", "/api/admin/devices/encoders/" + S3, { inputs: ["HDMI2", "HDMI1"] });
      check(
        "Devices API: valid inputs saved in a fixed order",
        r.status === 200 &&
          JSON.stringify(r.json.encoders.find((e) => e.ip === S3).inputs) ===
            JSON.stringify(["HDMI1", "HDMI2"]),
      );
      t0 = Date.now();
      r = await admin("POST", "/api/source-input", { encoderIp: S3, input: "HDMI2" });
      check(
        "an offline encoder -> not confirmed, no input known",
        r.status === 200 && r.json.ok === false && r.json.input === null && Date.now() - t0 > 2500,
        `${Date.now() - t0} ms`,
      );
      r = await admin("PATCH", "/api/admin/devices/encoders/" + S3, { inputs: [] });
      check(
        "Devices API: an empty list clears input switching",
        r.status === 200 && !("inputs" in r.json.encoders.find((e) => e.ip === S3)),
      );
      r = await admin("PATCH", "/api/admin/devices/encoders/" + S1, { name: "Source 1 renamed" });
      check(
        "editing an encoder keeps its inputs",
        JSON.stringify(r.json.encoders.find((e) => e.ip === S1).inputs) ===
          JSON.stringify(["HDMI1", "HDMI2", "USB-C", "AUTO"]),
      );
      await admin("PATCH", "/api/admin/devices/encoders/" + S1, { name: "Source 1" });

      // live permission change
      await admin("PATCH", `/api/admin/groups/${gIn.id}`, { inputControl: false });
      r = await inu("POST", "/api/source-input", { encoderIp: S1, input: "HDMI1" });
      check("unticking the group box blocks the open session at once", r.status === 403);
      r = await inu("GET", "/api/devices");
      check(
        "...and canInput drops to false in its snapshot",
        r.json.sources.every((s) => s.canInput === false),
      );

      const act = (await admin("GET", "/api/admin/activity")).json.filter(
        (e) => e.type === "source_input",
      );
      check(
        "activity: who changed which input to what, with the result; plain reads not logged",
        act.some((e) => e.username === "inu" && e.input === "HDMI2" && e.result === "confirmed") &&
          act.some((e) => e.input === "HDMI2" && e.result === "not confirmed") &&
          !act.some((e) => e.input === null),
      );
    }
    // ====================================================================== group managers follow the Manager role
    if (want("managers")) {
      const mkRole = async (username, role) => {
        const u = (
          await admin("POST", "/api/admin/users", {
            name: username.toUpperCase(),
            username,
            role,
            groups: [],
          })
        ).json;
        const s = session();
        await s("POST", "/api/login", { username, password: u.tempPassword });
        await s("POST", "/api/change-password", {
          currentPassword: u.tempPassword,
          newPassword: `${username}-test-pass-1`,
        });
        await s("POST", "/api/login", { username, password: `${username}-test-pass-1` });
        return { id: u.user.id, s };
      };
      const m1 = await mkRole("mgr1", "manager");
      const m2 = await mkRole("mgr2", "manager");
      await mkRole("plain1", "user");
      const grp = (
        await admin("POST", "/api/admin/groups", {
          name: "Mgr test",
          spaces: [],
          sources: [],
          managers: ["mgr1", "mgr2", "plain1", "ghost"],
        })
      ).json;
      check(
        "a group only keeps real Managers (a plain user and a made-up name are dropped)",
        JSON.stringify(grp.managers) === JSON.stringify(["mgr1", "mgr2"]),
        JSON.stringify(grp.managers),
      );
      let r = await admin("PATCH", `/api/admin/groups/${grp.id}`, {
        managers: ["mgr1", "plain1", "mgr1"],
      });
      check(
        "saving a group filters and de-duplicates managers too",
        JSON.stringify(r.json.managers) === JSON.stringify(["mgr1"]),
      );
      await admin("PATCH", `/api/admin/groups/${grp.id}`, { managers: ["mgr1", "mgr2"] });
      const managersOf = async () =>
        (await admin("GET", "/api/admin/groups")).json.find((g) => g.id === grp.id).managers;

      r = await m1.s("GET", "/api/admin/groups");
      check(
        "while a Manager, mgr1 sees the group they manage",
        r.json.some((g) => g.id === grp.id),
      );
      r = await admin("POST", `/api/admin/users/${m1.id}/role`, { role: "user" });
      check(
        "demoting a Manager -> 200 and the reply says how many groups they were removed from",
        r.status === 200 && r.json.groupsUpdated === 1,
        JSON.stringify(r.json && r.json.groupsUpdated),
      );
      check(
        "...they are gone from the group's managers, the other manager stays",
        JSON.stringify(await managersOf()) === JSON.stringify(["mgr2"]),
      );
      await admin("POST", `/api/admin/users/${m1.id}/role`, { role: "manager" });
      check(
        "giving them the role back does NOT quietly restore the old group",
        JSON.stringify(await managersOf()) === JSON.stringify(["mgr2"]),
      );
      r = await m1.s("GET", "/api/admin/groups");
      check(
        "...so as a Manager again they see no groups until an admin ticks them",
        r.status === 200 && r.json.length === 0,
      );
      r = await admin("POST", `/api/admin/users/${m2.id}/role`, { role: "admin" });
      check(
        "promoting a Manager to admin also removes them from group managers",
        r.json.groupsUpdated === 1 && (await managersOf()).length === 0,
      );
      r = await admin("POST", `/api/admin/users/${m1.id}/role`, { role: "manager" });
      check(
        "changing a role that doesn't affect any group reports 0 groups updated",
        r.status === 200 && r.json.groupsUpdated === 0,
      );
      const act = (await admin("GET", "/api/admin/activity")).json.filter(
        (e) => e.type === "admin_user_role",
      );
      check(
        "activity notes the removal from groups",
        act.some(
          (e) =>
            e.username === "mgr1" && /removed from the managers of 1 group/.test(e.detail || ""),
        ),
      );
      const m3 = await mkRole("mgr3", "manager");
      await admin("PATCH", `/api/admin/groups/${grp.id}`, { managers: ["mgr3"] });
      await admin("DELETE", `/api/admin/users/${m3.id}`);
      check(
        "deleting a Manager removes them from group managers",
        (await managersOf()).length === 0,
      );
    }
  } catch (e) {
    check("HARNESS ERROR: " + e.message + "\n" + (e.stack || ""), false);
  } finally {
    for (const k of kids)
      try {
        k.kill();
      } catch (err) {
        console.log(`could not stop a child process: ${err.message}`);
      }
    await sleep(300);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  if (results.some((r) => !r[1]))
    console.log(
      "---- server output (errors) ----\n" +
        out
          .split("\n")
          .filter((l) => /Error|EPERM|EBUSY|at /.test(l))
          .slice(0, 25)
          .join("\n"),
    );
  let pass = 0;
  for (const [name, ok, extra] of results) {
    console.log(ok ? "PASS" : "FAIL", name, !ok && extra ? `  [${extra}]` : "");
    if (ok) pass++;
  }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
