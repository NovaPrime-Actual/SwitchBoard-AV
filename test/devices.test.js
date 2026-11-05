// End-to-end check of the in-app device editor against the 127.x mock decoders (never real devices).
import { spawn, fork } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP = path.join(__dirname, "..");
const DATA = path.join(os.tmpdir(), "switchboard-av-test-devices-data");
const PORT = 18086;
const SERIAL = "16753";
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
const results = [];
const check = (name, ok, extra) => results.push([name, !!ok, extra]);

function session() {
  let cookie = "";
  const call = async (method, url, body, raw) => {
    const res = await fetch(base + url, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    if (raw) return { status: res.status, headers: res.headers, text: await res.text() };
    let json;
    try {
      json = await res.json();
    } catch {
      json = null; // the body is not JSON
    }
    return { status: res.status, json };
  };
  return call;
}

const env = () => ({
  ...process.env,
  DEVICES_FILE: path.join(APP, "test", "devices.test.json"),
  DATA_DIR: DATA,
  PORT: String(PORT),
  BIND: "127.0.0.1",
  TLS: "off",
  TV_SERIAL_PORT: SERIAL,
});
let out = "";
function startServer() {
  out = "";
  const srv = spawn(process.execPath, ["server.js"], { cwd: APP, env: env() });
  kids.push(srv);
  srv.stdout.on("data", (d) => (out += d));
  srv.stderr.on("data", (d) => (out += d));
  return srv;
}

(async () => {
  try {
    const mock = fork(path.join(APP, "test", "mock-decoders.js"), [], {
      cwd: APP,
      env: env(),
      silent: true,
    });
    kids.push(mock);
    await new Promise((r) => mock.once("message", r));
    await sleep(300);

    let srv = startServer();
    await sleep(1500);
    if (!out.includes("devices.test.json")) throw new Error("server not on the test devices file");
    check("first start imports the list and says so", /imported 5 screens and 3 sources/.test(out));
    check(
      "devices.store.json written on first start",
      fs.existsSync(path.join(DATA, "devices.store.json")),
    );
    const adminPw = /temporary password: (\S+)/.exec(out)[1];

    const admin = session();
    await admin("POST", "/api/login", { username: "admin", password: adminPw });
    await admin("POST", "/api/change-password", {
      currentPassword: adminPw,
      newPassword: "admin-test-pass-1",
    });
    await admin("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });

    const D = "/api/admin/devices";
    let r = await admin("GET", D);
    check(
      "list returns the imported 5 screens / 3 sources, TV protocols, empty history",
      r.status === 200 &&
        r.json.decoders.length === 5 &&
        r.json.encoders.length === 3 &&
        r.json.tvProtocols.includes("lg") &&
        r.json.history.length === 0,
    );

    // groups + users for cascade checks
    const g1 = (
      await admin("POST", "/api/admin/groups", {
        name: "Crew",
        spaces: ["Space A"],
        decoders: ["127.0.1.22"],
        excludeDecoders: ["127.0.1.12"],
        sources: ["127.0.2.11", "127.0.2.12"],
        tvPower: true,
      })
    ).json;
    const gAll = (
      await admin("POST", "/api/admin/groups", { name: "Everything", spaces: [], sources: "all" })
    ).json;
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
    const crew = await mkUser("crew", [g1.id]);
    const plain = await mkUser("plain", [gAll.id]);
    const ips = async (s) => (await s("GET", "/api/devices")).json.decoders.map((d) => d.ip).sort();
    check(
      "baseline: crew sees A1 (space) + B2 (individual), not A2 (excluded)",
      JSON.stringify(await ips(crew)) === JSON.stringify(["127.0.1.11", "127.0.1.22"]),
    );

    // permissions
    r = await crew("GET", D);
    check("non-admin cannot read the device list (403)", r.status === 403);
    r = await crew("POST", D + "/decoders", { name: "X", ip: "127.0.9.9" });
    check("non-admin cannot add a screen (403)", r.status === 403);
    r = await plain("POST", D + "/import", {
      kind: "decoders",
      text: "X,Y,127.0.9.9",
      dryRun: true,
    });
    check("non-admin cannot import (403)", r.status === 403);

    // add + validation
    r = await admin("POST", D + "/decoders", {
      name: "New Lobby",
      space: "Space A",
      ip: "127.0.1.50",
      tvPower: "lg",
      tvSetId: "01",
    });
    check(
      "add a screen -> 200 and it is stored with its TV settings",
      r.status === 200 &&
        r.json.decoders.some(
          (d) => d.ip === "127.0.1.50" && d.tvPower === "lg" && d.tvSetId === "01",
        ),
    );
    check(
      "a user whose group has the space sees the new screen immediately",
      (await ips(crew)).includes("127.0.1.50"),
    );
    r = await admin("POST", D + "/decoders", { name: "Dup", ip: "127.0.1.50" });
    check(
      "duplicate IP -> 400 naming both devices",
      r.status === 400 && /used by both New Lobby and Dup/.test(r.json.error),
      r.json && r.json.error,
    );
    r = await admin("POST", D + "/decoders", { name: "Clash", ip: "127.0.2.11" });
    check(
      "IP already used by a source -> 400 naming both",
      r.status === 400 &&
        /used by both Source 1 and Clash|used by both Clash and Source 1/.test(r.json.error),
      r.json && r.json.error,
    );
    r = await admin("POST", D + "/decoders", { name: "Bad", ip: "300.1.1.1" });
    check("invalid IP -> 400", r.status === 400 && /not a valid IP/.test(r.json.error));
    r = await admin("POST", D + "/decoders", { name: "", ip: "127.0.1.60" });
    check("missing name -> 400", r.status === 400 && /no name/.test(r.json.error));
    r = await admin("POST", D + "/decoders", {
      name: "Odd TV",
      ip: "127.0.1.61",
      tvPower: "samsung",
    });
    check("unknown TV type -> 400", r.status === 400 && /unknown TV power type/.test(r.json.error));
    r = await admin("POST", D + "/decoders", {
      name: "BadSet",
      ip: "127.0.1.62",
      tvPower: "lg",
      tvSetId: "zz",
    });
    check("bad TV Set ID -> 400", r.status === 400 && /Set ID/.test(r.json.error));
    r = await admin("POST", D + "/decoders", "{not json");
    check("malformed body -> 400 (not 500)", r.status === 400);
    r = await admin("POST", D + "/decoders", { name: "No space given", ip: "127.0.1.63" });
    check(
      "blank space becomes 'Unassigned'",
      r.status === 200 && r.json.decoders.find((d) => d.ip === "127.0.1.63").space === "Unassigned",
    );

    // edit + cascade on IP change
    r = await admin("PATCH", D + "/decoders/127.0.1.22", { name: "B2 renamed", ip: "127.0.1.72" });
    check(
      "edit name + IP -> 200, one group updated",
      r.status === 200 && r.json.groupsUpdated === 1,
      JSON.stringify(r.json && r.json.groupsUpdated),
    );
    let groups = (await admin("GET", "/api/admin/groups")).json;
    let crewGroup = groups.find((g) => g.id === g1.id);
    check(
      "group follows the IP change (decoders list)",
      crewGroup.decoders.includes("127.0.1.72") && !crewGroup.decoders.includes("127.0.1.22"),
    );
    check(
      "crew still sees the moved screen under its new IP",
      (await ips(crew)).includes("127.0.1.72"),
    );
    r = await admin("PATCH", D + "/decoders/127.0.1.12", { ip: "127.0.1.82" });
    groups = (await admin("GET", "/api/admin/groups")).json;
    crewGroup = groups.find((g) => g.id === g1.id);
    check(
      "exclusion follows an IP change too (A2 stays hidden)",
      crewGroup.excludeDecoders.includes("127.0.1.82") && !(await ips(crew)).includes("127.0.1.82"),
    );
    r = await admin("PATCH", D + "/decoders/127.0.1.82", { ip: "127.0.1.11" });
    check("changing to an IP in use -> 400", r.status === 400);
    r = await admin("PATCH", D + "/decoders/127.0.1.11", { tvPower: "" });
    check(
      "clearing TV power removes the setting",
      r.status === 200 && !("tvPower" in r.json.decoders.find((d) => d.ip === "127.0.1.11")),
    );
    r = await admin("PATCH", D + "/decoders/10.9.9.9", { name: "x" });
    check("editing an unknown screen -> 404", r.status === 404);

    // delete + cascade
    r = await admin("DELETE", D + "/decoders/127.0.1.72");
    groups = (await admin("GET", "/api/admin/groups")).json;
    crewGroup = groups.find((g) => g.id === g1.id);
    check(
      "delete a screen -> removed from the group and from the user's view",
      r.status === 200 &&
        !crewGroup.decoders.includes("127.0.1.72") &&
        !(await ips(crew)).includes("127.0.1.72"),
    );
    r = await crew("POST", "/api/route", { decoderIp: "127.0.1.72", encoderIp: "127.0.2.11" });
    check("routing to a deleted screen is refused", r.status === 400);

    // encoder cascade
    r = await admin("PATCH", D + "/encoders/127.0.2.11", { name: "Source 1b", ip: "127.0.2.21" });
    groups = (await admin("GET", "/api/admin/groups")).json;
    crewGroup = groups.find((g) => g.id === g1.id);
    check(
      "source IP change cascades into the group's sources",
      r.status === 200 &&
        crewGroup.sources.includes("127.0.2.21") &&
        !crewGroup.sources.includes("127.0.2.11"),
      JSON.stringify(crewGroup.sources),
    );
    check(
      "a group set to 'all sources' is left as 'all'",
      groups.find((g) => g.id === gAll.id).sources === "all",
    );
    const srcs = (await crew("GET", "/api/devices")).json.sources.map((s) => s.name).sort();
    check(
      "crew sees the renamed source",
      JSON.stringify(srcs) === JSON.stringify(["Source 1b", "Source 2"]),
      JSON.stringify(srcs),
    );
    r = await admin("DELETE", D + "/encoders/127.0.2.12");
    crewGroup = (await admin("GET", "/api/admin/groups")).json.find((g) => g.id === g1.id);
    check(
      "delete a source -> removed from the group",
      r.status === 200 && !crewGroup.sources.includes("127.0.2.12"),
    );
    r = await admin("POST", D + "/encoders", { name: "Source 9", ip: "127.0.2.19" });
    check("add a source", r.status === 200 && r.json.encoders.some((e) => e.ip === "127.0.2.19"));

    // space rename cascade
    r = await admin("POST", D + "/spaces/rename", { from: "Space A", to: "Studio A" });
    crewGroup = (await admin("GET", "/api/admin/groups")).json.find((g) => g.id === g1.id);
    check(
      "rename a space -> group's spaces updated, access unchanged",
      r.status === 200 &&
        crewGroup.spaces.includes("Studio A") &&
        !crewGroup.spaces.includes("Space A") &&
        (await ips(crew)).includes("127.0.1.11"),
    );
    check(
      "...and screens show the new space name",
      (await crew("GET", "/api/devices")).json.decoders.every((d) => d.space !== "Space A"),
    );
    r = await admin("POST", D + "/spaces/rename", { from: "Nope", to: "x" });
    check("renaming a space that doesn't exist -> 404", r.status === 404);
    r = await admin("POST", D + "/spaces/rename", { from: "Studio A", to: "" });
    check("empty new space name -> 400", r.status === 400);

    // spaces as a real list: add / delete / rename, empty spaces
    r = await admin("GET", D);
    check(
      "list carries the spaces list incl. every space screens use",
      ["Studio A", "Space B", "Space C", "Unassigned"].every((s) => r.json.spaces.includes(s)),
      JSON.stringify(r.json.spaces),
    );
    r = await crew("POST", D + "/spaces", { name: "Nope" });
    check("non-admin cannot add a space (403)", r.status === 403);
    r = await admin("POST", D + "/spaces", { name: "Gym" });
    check(
      "add an empty space -> 200 and it is last in the list",
      r.status === 200 && r.json.spaces[r.json.spaces.length - 1] === "Gym",
    );
    const adminSpaces = (await admin("GET", "/api/admin/spaces")).json;
    check(
      "the group editor's space list includes the empty space",
      adminSpaces.some((s) => s.name === "Gym" && s.decoders.length === 0),
    );
    r = await admin("POST", D + "/spaces", { name: "gym" });
    check(
      "duplicate space name (any case) -> 400",
      r.status === 400 && /already exists/.test(r.json.error),
    );
    r = await admin("POST", D + "/spaces", { name: "   " });
    check("blank space name -> 400", r.status === 400);
    r = await admin("POST", D + "/spaces", { name: "x".repeat(65) });
    check("65-character space name -> 400", r.status === 400);
    r = await admin("PATCH", D + "/decoders/127.0.1.11", { space: "Gym" });
    let lst = (await admin("GET", D)).json;
    check(
      "moving a screen into the empty space works, no duplicate space appears",
      r.status === 200 &&
        lst.spaces.filter((s) => s === "Gym").length === 1 &&
        lst.decoders.find((d) => d.ip === "127.0.1.11").space === "Gym",
    );
    r = await admin("DELETE", D + "/spaces/Gym");
    check(
      "deleting a space that still has a screen -> 400 saying how many",
      r.status === 400 && /still has 1 screen\b/.test(r.json.error),
      r.json && r.json.error,
    );
    await admin("PATCH", D + "/decoders/127.0.1.11", { space: "Studio A" });
    lst = (await admin("GET", D)).json;
    check(
      "moving the last screen out leaves the (now empty) space in the list",
      lst.spaces.includes("Gym"),
    );
    r = await admin("POST", D + "/spaces", { name: "Spare" });
    r = await admin("POST", D + "/spaces/rename", { from: "Spare", to: "Reserve" });
    lst = (await admin("GET", D)).json;
    check(
      "rename an empty space -> 200",
      r.status === 200 && lst.spaces.includes("Reserve") && !lst.spaces.includes("Spare"),
    );
    const gRes = (
      await admin("POST", "/api/admin/groups", {
        name: "Reserve crew",
        spaces: ["Reserve", "Studio A"],
        sources: [],
      })
    ).json;
    r = await admin("DELETE", D + "/spaces/Reserve");
    const gResNow = (await admin("GET", "/api/admin/groups")).json.find((g) => g.id === gRes.id);
    check(
      "delete an empty space -> 200, one group updated, group keeps its other space",
      r.status === 200 &&
        r.json.groupsUpdated === 1 &&
        JSON.stringify(gResNow.spaces) === JSON.stringify(["Studio A"]),
      JSON.stringify(gResNow && gResNow.spaces),
    );
    check(
      "...and the space is gone from the list",
      !(await admin("GET", D)).json.spaces.includes("Reserve"),
    );
    r = await admin("DELETE", D + "/spaces/NoSuchSpace");
    check("deleting an unknown space -> 404", r.status === 404);
    r = await crew("DELETE", D + "/spaces/Gym");
    check("non-admin cannot delete a space (403)", r.status === 403);
    const delSnap = (await admin("GET", D)).json.history.find((h) =>
      /^delete space Reserve/.test(h.reason),
    );
    r = await admin("POST", D + "/restore", { at: delSnap.at });
    check(
      "restoring the snapshot before a space delete brings the space back",
      r.status === 200 && (await admin("GET", D)).json.spaces.includes("Reserve"),
    );
    await admin("DELETE", D + "/spaces/Reserve");

    // import
    const before = (await admin("GET", D)).json.decoders.length;
    r = await admin("POST", D + "/import", {
      kind: "decoders",
      dryRun: true,
      text: "name\tspace\tip\ttvPower\nImp 1\tStudio A\t127.0.1.101\tlg\nImp 2\tStudio A\t127.0.1.102\t\nImp 3\tHall\t127.0.1.101\nBad\tHall\t999.1.1.1\nSame as existing\tHall\t127.0.1.11",
    });
    check(
      "dry run reports every problem with its line number and changes nothing",
      r.status === 200 &&
        r.json.ok === false &&
        r.json.errors.length === 3 &&
        /Line 4: .*already appears on line 2/.test(r.json.errors[0]) &&
        (await admin("GET", D)).json.decoders.length === before,
      JSON.stringify(r.json.errors),
    );
    r = await admin("POST", D + "/import", {
      kind: "decoders",
      text: "Imp 1\tStudio A\t127.0.1.101\tlg\nImp 2\tStudio A\t127.0.1.102\t\nImp 3\tHall\t127.0.1.101",
    });
    check(
      "import with a problem is all-or-nothing",
      r.json.ok === false && (await admin("GET", D)).json.decoders.length === before,
    );
    r = await admin("POST", D + "/import", {
      kind: "decoders",
      text: "Imp 1,Studio A,127.0.1.101,lg\nImp 2,Studio A,127.0.1.102,none\n\nImp 3,Hall,127.0.1.103",
    });
    check(
      "good comma-separated import adds all 3 (blank line and 'none' ok)",
      r.json.ok === true &&
        r.json.added === 3 &&
        (await admin("GET", D)).json.decoders.length === before + 3,
    );
    r = await admin("POST", D + "/import", { kind: "encoders", text: "Feed X,127.0.2.50" });
    check("encoder import works", r.json.ok === true && r.json.added === 1, JSON.stringify(r.json));
    r = await admin("POST", D + "/import", { kind: "decoders", text: "   \n\n" });
    check("empty paste -> 400", r.status === 400);

    // test (read-only)
    r = await admin("POST", D + "/test", { ip: "127.0.1.11" });
    check(
      "test on a mock decoder -> reachable",
      r.status === 200 &&
        r.json.reachable === true &&
        /UNIT\.MODEL=D5200/.test(r.json.reply) &&
        r.json.ms < 500,
      JSON.stringify(r.json),
    );
    r = await admin("POST", D + "/test", { ip: "127.0.1.12", tv: true });
    check(
      "test with TV check -> serial read ok",
      r.status === 200 && r.json.tv && r.json.tv.ok === true && typeof r.json.tv.on === "boolean",
      JSON.stringify(r.json && r.json.tv),
    );
    const t0 = Date.now();
    r = await admin("POST", D + "/test", { ip: "127.0.1.199" });
    check(
      "test on an IP nothing answers at -> reachable false after ~2 s",
      r.status === 200 && r.json.reachable === false && Date.now() - t0 > 1800,
      `${Date.now() - t0} ms`,
    );
    r = await admin("POST", D + "/test", { ip: "not-an-ip" });
    check("test with a bad IP -> 400", r.status === 400);

    // export
    r = await admin("GET", D + "/export", undefined, true);
    const exported = JSON.parse(r.text);
    check(
      "export is a downloadable devices.json shape with the current list",
      r.status === 200 &&
        /attachment; filename="devices.json"/.test(r.headers.get("content-disposition")) &&
        Array.isArray(exported.decoders) &&
        exported.decoders.length === before + 3 &&
        exported.encoders.length > 0,
    );

    // history + restore
    r = await admin("GET", D);
    const hist = r.json.history;
    check(
      "history lists changes newest first with who/what (capped at the default 10)",
      hist.length === 10 && hist[0].by === "admin" && typeof hist[0].reason === "string",
    );
    const importSnap = hist.find((h) => /^import 3 screens/.test(h.reason));
    check("history entry exists for the import", !!importSnap);
    r = await admin("POST", D + "/restore", { at: importSnap.at });
    check(
      "restore puts the list back to before that import",
      r.status === 200 &&
        r.json.decoders.length === before &&
        !r.json.decoders.some((d) => d.ip === "127.0.1.101"),
    );
    r = await admin("POST", D + "/restore", { at: 12345 });
    check("restoring an unknown snapshot -> 404", r.status === 404);

    // persistence across a restart
    const listBefore = (await admin("GET", D)).json;
    srv.kill();
    await sleep(600);
    srv = startServer();
    await sleep(1500);
    check(
      "restart loads the saved list, not the first-run file",
      /Device list +saved in the data folder/.test(out) && !/imported/.test(out),
    );
    const admin2 = session();
    await admin2("POST", "/api/login", { username: "admin", password: "admin-test-pass-1" });
    const listAfter = (await admin2("GET", D)).json;
    check(
      "edited list (renames, additions) survives the restart",
      JSON.stringify(listAfter.decoders) === JSON.stringify(listBefore.decoders) &&
        JSON.stringify(listAfter.encoders) === JSON.stringify(listBefore.encoders),
    );
    check(
      "the spaces list (including the empty 'Gym') survives the restart",
      JSON.stringify(listAfter.spaces) === JSON.stringify(listBefore.spaces) &&
        listAfter.spaces.includes("Gym"),
      JSON.stringify(listAfter.spaces),
    );
    check("history survives the restart", listAfter.history.length === listBefore.history.length);

    // restore the list from an uploaded file
    const original = fs.readFileSync(path.join(APP, "test", "devices.test.json"), "utf8");
    const beforeFile = JSON.stringify((await admin2("GET", D)).json.decoders);
    r = await admin2("POST", D + "/import-file", { text: original, dryRun: true });
    check(
      "dry run of a good file reports what would change",
      r.status === 200 &&
        r.json.ok &&
        r.json.dryRun &&
        r.json.screens === 5 &&
        r.json.sources === 3 &&
        r.json.spaces === 3 &&
        typeof r.json.screensAdded === "number" &&
        typeof r.json.groupSettingsMissing === "number",
      r.json,
    );
    check(
      "...and a dry run changes nothing",
      JSON.stringify((await admin2("GET", D)).json.decoders) === beforeFile,
    );
    r = await admin2("POST", D + "/import-file", { text: original });
    check(
      "importing the uploaded file replaces the list (5 screens, 3 sources)",
      r.status === 200 && r.json.decoders.length === 5 && r.json.encoders.length === 3,
      r.json,
    );
    check(
      "...and the spaces list is the file's three spaces",
      JSON.stringify((await admin2("GET", D)).json.spaces) ===
        JSON.stringify(["Space A", "Space B", "Space C"]),
    );
    const exp2 = JSON.parse((await admin2("GET", D + "/export", undefined, true)).text);
    check(
      "export now carries the spaces list too",
      Array.isArray(exp2.spaces) && exp2.spaces.length === 3,
    );
    const hist2 = (await admin2("GET", D)).json.history;
    check(
      "...and kept a snapshot so it can be undone",
      /restore the list from an uploaded file/.test(hist2[0].reason),
    );
    // round trip: the downloaded list can be uploaded again as it is
    const exportedAgain = (await admin2("GET", D + "/export", undefined, true)).text;
    r = await admin2("POST", D + "/import-file", { text: exportedAgain });
    check(
      "a downloaded list uploads again and gives the same list",
      r.status === 200 &&
        JSON.stringify(r.json.decoders) === JSON.stringify(exp2.decoders) &&
        JSON.stringify(r.json.encoders) === JSON.stringify(exp2.encoders),
      r.status,
    );
    // bad files are refused in plain words and change nothing
    const keep = JSON.stringify((await admin2("GET", D)).json.decoders);
    for (const [label, text, re] of [
      ["not JSON", "this is not json", /not valid JSON/],
      ["a JSON list, not a device list", "[1,2,3]", /does not look like a device list/],
      ["empty lists", '{"decoders":[],"encoders":[]}', /no screens or sources/],
      ["empty object", "{}", /no screens or sources/],
      ["lists that are not lists", '{"decoders":"x","encoders":1}', /should be lists/],
      ["entries that are not objects", '{"decoders":[5],"encoders":[]}', /needs a name and an IP/],
      [
        "a bad IP",
        '{"decoders":[{"name":"X","space":"S","ip":"999.1.1.1"}],"encoders":[]}',
        /not a valid IP/,
      ],
      [
        "the same IP twice",
        '{"decoders":[{"name":"X","space":"S","ip":"10.0.0.1"}],"encoders":[{"name":"Y","ip":"10.0.0.1"}]}',
        /used by both/,
      ],
      ["no name", '{"decoders":[{"space":"S","ip":"10.0.0.1"}],"encoders":[]}', /no name/],
    ]) {
      r = await admin2("POST", D + "/import-file", { text });
      check("uploaded file refused: " + label, r.status === 400 && re.test(r.json.error), r.json);
    }
    r = await admin2("POST", D + "/import-file", { text: "x".repeat(2100000) });
    check(
      "an oversized file is a clean 400",
      r.status === 400 && /too large/.test(r.json.error),
      r.status,
    );
    r = await admin2("POST", D + "/import-file", { dryRun: true });
    check("no file text at all is refused", r.status === 400, r.json);
    check(
      "refused files changed nothing",
      JSON.stringify((await admin2("GET", D)).json.decoders) === keep,
    );
    r = await admin2("POST", D + "/reimport", {});
    check("the old read-the-server-file re-import is gone", r.status === 404, r.status);

    // activity log
    const act = (await admin2("GET", "/api/admin/activity")).json.filter(
      (e) => e.type === "admin_device",
    );
    check(
      "activity log records device changes with who and what",
      act.length > 10 &&
        act.every((e) => e.by && e.detail) &&
        act.some((e) => /rename space Space A -> Studio A/.test(e.detail)),
    );
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
          .filter((l) => /Devices API error|Error|EPERM|EBUSY|at /.test(l))
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
