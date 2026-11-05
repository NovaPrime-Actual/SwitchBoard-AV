// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// MOCK VISIONARY DECODERS — test harness support
// Binds one UDP socket per decoder IP in test/devices.test.json (or MOCK_DEVICES_FILE)
// on decoderPort (default 8000) and replies the same way real Visionary decoders do:
//   QUERY.KEY=STREAM.HOST          -> API.STATUS=SUCCESS_QUERY_KEY&STREAM.HOST=<host> (if set)
//   STREAM.HOST=<ip>&...CONNECT=TRUE -> API.STATUS=SUCCESS, and updates its stored host
//   any other QUERY.*               -> API.STATUS=SUCCESS_QUERY_KEY&INFO=mock-value (read-only)
// Refuses to start if any configured IP is not a 127.x loopback address.
// Run under a parent process via child_process.fork() to get IPC (getCounts/getState).
// ===========================================

import dgram from "node:dgram";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const configFile = process.env.MOCK_DEVICES_FILE
  ? path.resolve(process.env.MOCK_DEVICES_FILE)
  : path.join(__dirname, "devices.test.json");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const decoderPort = config.decoderPort || 8000;

const allIps = [...config.decoders.map((d) => d.ip), ...config.encoders.map((e) => e.ip)];
for (const ip of allIps) {
  if (!ip.startsWith("127.")) {
    console.error(`[mock-decoders] refusing to start: ${ip} is not a 127.x loopback address`);
    process.exit(1);
  }
}

const deviceByIp = new Map(
  [...config.decoders, ...config.encoders.map((e) => ({ ...e, kind: "encoder" }))].map((d) => [
    d.ip,
    d,
  ]),
);
const inputs = new Map(config.encoders.map((e) => [e.ip, "HDMI1"])); // STREAM.VIDEO on each encoder
const output = new Map(config.decoders.map((d) => [d.ip, "NORMAL"])); // VIDEO.OUTPUT
const osd = new Map(config.decoders.map((d) => [d.ip, ""])); // VIDEO.OSD_TEXT
const state = new Map(); // decoder ip -> currently tuned encoder ip, or null
const queryCounts = new Map(); // decoder ip -> number of STREAM.HOST queries received
for (const d of config.decoders) {
  state.set(d.ip, null);
  queryCounts.set(d.ip, 0);
}

function send(sock, fromIp, rinfo, text) {
  console.log(`[mock-decoders] ${fromIp} TX -> ${rinfo.address}:${rinfo.port} ${text}`);
  sock.send(Buffer.from(text), rinfo.port, rinfo.address);
}

function handleMessage(ip, sock, text, rinfo) {
  console.log(`[mock-decoders] ${ip} RX <- ${rinfo.address}:${rinfo.port} ${text}`);

  // Check for the STREAM.HOST *query* before anything else — the set command also contains
  // the literal text "STREAM.HOST=", so order matters.
  if (text.includes("QUERY.KEY=STREAM.HOST")) {
    queryCounts.set(ip, (queryCounts.get(ip) || 0) + 1);
    const host = state.get(ip);
    const reply = host
      ? `API.STATUS=SUCCESS_QUERY_KEY&STREAM.HOST=${host}`
      : "API.STATUS=SUCCESS_QUERY_KEY";
    send(sock, ip, rinfo, reply);
    return;
  }

  const setMatch = text.match(/STREAM\.HOST=(\d+\.\d+\.\d+\.\d+)/);
  if (setMatch && text.includes("STREAM.CONNECT=TRUE")) {
    // "mockIgnoreSet": true acknowledges the command but never tunes (a decoder that fails to switch)
    if (!(deviceByIp.get(ip) || {}).mockIgnoreSet) {
      state.set(ip, setMatch[1]);
      output.set(ip, "NORMAL"); // like the real decoder: tuning resets the output mode
    }
    send(sock, ip, rinfo, "API.STATUS=SUCCESS");
    return;
  }

  // screen output mode and on-screen message (set, then query)
  const outSet = text.match(/VIDEO\.OUTPUT=([A-Z]+)/);
  if (outSet && !text.includes("QUERY.")) {
    output.set(ip, outSet[1]);
    send(sock, ip, rinfo, "API.STATUS=SUCCESS");
    return;
  }
  const osdSet = text.match(/VIDEO\.OSD_TEXT=([^&]*)/);
  if (osdSet && !text.includes("QUERY.")) {
    osd.set(ip, osdSet[1]);
    send(sock, ip, rinfo, "API.STATUS=SUCCESS");
    return;
  }
  if (text.includes("QUERY.KEY=VIDEO.OUTPUT")) {
    send(sock, ip, rinfo, `&VIDEO.OUTPUT=${output.get(ip)}&API.STATUS=SUCCESS_QUERY_KEY`);
    return;
  }
  if (text.includes("QUERY.KEY=VIDEO.OSD_TEXT")) {
    send(sock, ip, rinfo, `&VIDEO.OSD_TEXT=${osd.get(ip)}&API.STATUS=SUCCESS_QUERY_KEY`);
    return;
  }

  // encoder input select (STREAM.VIDEO). "mockNoInputChange": true acknowledges but does not change it.
  const vidSet = text.match(/STREAM\.VIDEO=([A-Za-z0-9-]+)/);
  if (vidSet && !text.includes("QUERY.")) {
    if (!(deviceByIp.get(ip) || {}).mockNoInputChange) inputs.set(ip, vidSet[1].toUpperCase());
    send(sock, ip, rinfo, "API.STATUS=SUCCESS");
    return;
  }
  if (text.includes("QUERY.KEY=STREAM.VIDEO")) {
    send(
      sock,
      ip,
      rinfo,
      `&STREAM.VIDEO=${inputs.get(ip) || "HDMI1"}&API.STATUS=SUCCESS_QUERY_KEY`,
    );
    return;
  }

  if (text.includes("QUERY.KEY=UNIT.MODEL")) {
    send(sock, ip, rinfo, `&UNIT.MODEL=${modelOf(ip)}&API.STATUS=SUCCESS_QUERY_KEY`);
    return;
  }

  if (text.includes("QUERY.")) {
    send(sock, ip, rinfo, "API.STATUS=SUCCESS_QUERY_KEY&INFO=mock-value");
    return;
  }

  send(sock, ip, rinfo, "API.STATUS=SUCCESS");
}

const modelOf = (ip) => ((deviceByIp.get(ip) || {}).kind === "encoder" ? "E5200" : "D5200");

// "mockOffline": true means the unit never answers on UDP (powered off / unplugged).
for (const d of config.decoders) {
  if (d.mockOffline) continue;
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => handleMessage(d.ip, sock, msg.toString(), rinfo));
  sock.on("error", (err) => console.error(`[mock-decoders] ${d.ip} socket error:`, err.message));
  sock.bind(decoderPort, d.ip, () =>
    console.log(`[mock-decoders] listening on ${d.ip}:${decoderPort}`),
  );
}

// Encoders answer on the same UDP port (offline ones don't, like a decoder).
for (const e of config.encoders) {
  if (e.mockOffline) continue;
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => handleMessage(e.ip, sock, msg.toString(), rinfo));
  sock.on("error", (err) => console.error(`[mock-decoders] ${e.ip} socket error:`, err.message));
  sock.bind(decoderPort, e.ip, () =>
    console.log(`[mock-decoders] encoder listening on ${e.ip}:${decoderPort}`),
  );
}

// ---- serial-over-IP side: an LG TV behind each decoder's RS-232 port (TCP, TV_SERIAL_PORT / 6752) ----
// Decoders with "mockNoSerial": true in the test devices file don't listen, so connections are refused.
// A decoder with "mockSilentTv": true accepts the connection but the TV never answers.
const serialPort = process.env.TV_SERIAL_PORT ? Number(process.env.TV_SERIAL_PORT) : 6752;
const tvOn = new Map(); // decoder ip -> TV power, starts on
const tvCommands = new Map(); // decoder ip -> list of "ka .." commands received
const tvSetId = "00";

function lgReply(ip, line) {
  tvCommands.set(ip, [...(tvCommands.get(ip) || []), line]);
  const m = line.match(/^ka ([0-9a-f]{2}) ([0-9a-f]{2})$/i);
  if (!m) return null;
  if (m[1] !== tvSetId && m[1] !== "00") return `a ${m[1]} NG${m[2]}x`; // wrong Set ID
  if (m[2] === "01") tvOn.set(ip, true);
  else if (m[2] === "00") tvOn.set(ip, false);
  else if (m[2].toLowerCase() !== "ff") return `a ${m[1]} NG${m[2]}x`;
  return `a ${m[1]} OK${tvOn.get(ip) ? "01" : "00"}x`;
}

for (const d of config.decoders) {
  tvOn.set(d.ip, true);
  if (d.mockNoSerial) continue;
  const srv = net.createServer((conn) => {
    let buf = "";
    conn.setEncoding("latin1");
    conn.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\r")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        console.log(`[mock-decoders] ${d.ip} serial RX ${JSON.stringify(line)}`);
        if (d.mockSilentTv) continue;
        const out = lgReply(d.ip, line);
        if (out) conn.write(out, "latin1");
      }
    });
    conn.on("error", () => {});
  });
  srv.on("error", (err) =>
    console.error(`[mock-decoders] ${d.ip} serial listener error:`, err.message),
  );
  srv.listen(serialPort, d.ip, () =>
    console.log(`[mock-decoders] serial listening on ${d.ip}:${serialPort}`),
  );
}

// IPC with the test harness (only present when launched via child_process.fork()).
if (process.send) {
  process.on("message", (msg) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === "getCounts")
      process.send({ cmd: "counts", counts: Object.fromEntries(queryCounts) });
    if (msg.cmd === "getState") process.send({ cmd: "state", state: Object.fromEntries(state) });
    if (msg.cmd === "getInput") process.send({ cmd: "input", inputs: Object.fromEntries(inputs) });
    if (msg.cmd === "getScreen")
      process.send({
        cmd: "screen",
        output: Object.fromEntries(output),
        osd: Object.fromEntries(osd),
      });
    if (msg.cmd === "setOutput") output.set(msg.ip, msg.value); // simulate someone else blanking a screen
    if (msg.cmd === "getTv")
      process.send({
        cmd: "tv",
        tvOn: Object.fromEntries(tvOn),
        commands: Object.fromEntries(tvCommands),
      });
  });
  process.send({ cmd: "ready" });
}

console.log(
  `[mock-decoders] ready: ${config.decoders.length} decoders, ${config.encoders.length} encoders on :${decoderPort}`,
);
