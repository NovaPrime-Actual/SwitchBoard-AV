// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// DECODERS for SwitchBoard-AV
// Description: Talking to the Visionary decoders over UDP (and TV power through their serial port):
//   routing with a readback check, inputs, screen modes, health checks, and the replies that come back.
// ===========================================

import net from "node:net";
import {
  CONFIRM_DELAY_MS,
  CONFIRM_RETRY_MS,
  DECODER_PORT,
  HEALTH_CONCURRENCY,
  HEALTH_PROBE_MS,
  MAX_CONFIRM_ATTEMPTS,
  QUERY_TIMEOUT_MS,
  TESTER_TIMEOUT_MS,
  TV_PROTOCOLS,
  TV_RETRY_DELAY_MS,
  TV_SERIAL_PORT,
  TV_TIMEOUT_MS,
} from "./config.js";
import { config } from "./devicelist.js";
import { logDebug, logEvent } from "./log.js";
import { groupDecoderSet } from "./scoping.js";
import {
  busy,
  healthCache,
  healthRuns,
  inputBusy,
  inputState,
  lastKnown,
  lastReply,
  queryWaiters,
  rawWaiters,
  reachability,
  screenBusy,
  screenState,
  tvBusy,
  tvState,
  udp,
} from "./state.js";
import { store } from "./store.js";
import { mapLimited, sleep } from "./util.js";

function send(ip, text) {
  logDebug(`TX -> ${ip}:${DECODER_PORT} ${text}`);
  udp.send(Buffer.from(text), DECODER_PORT, ip);
}

// Ask the decoder which encoder it is tuned to. Resolves to an IP, or null on timeout.
export function queryHost(ip) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const list = queryWaiters.get(ip) || [];
      queryWaiters.set(
        ip,
        list.filter((f) => f !== done),
      );
      reachability.set(ip, false);
      resolve(null);
    }, QUERY_TIMEOUT_MS);
    const done = (host) => {
      clearTimeout(timer);
      resolve(host);
    };
    queryWaiters.set(ip, [...(queryWaiters.get(ip) || []), done]);
    send(ip, "CMD=START&UNIT.ID=ALL&QUERY.KEY=STREAM.HOST&CMD=END");
  });
}

// Query tester: send one read-only QUERY.KEY and collect every raw reply for a short window.
// The key is restricted to name characters so it cannot carry extra "&KEY=value" commands.
export function testQuery(ip, queryPart) {
  return new Promise((resolve) => {
    const replies = [];
    const feed = (text) => replies.push(text);
    rawWaiters.set(ip, [...(rawWaiters.get(ip) || []), feed]);
    const started = Date.now();
    send(ip, `CMD=START&UNIT.ID=ALL&${queryPart}&CMD=END`);
    setTimeout(() => {
      rawWaiters.set(
        ip,
        (rawWaiters.get(ip) || []).filter((f) => f !== feed),
      );
      resolve({ replies, ms: Date.now() - started });
    }, TESTER_TIMEOUT_MS);
  });
}

// Sends one read-only query and resolves on the FIRST reply (or the timeout) with { ok, text, ms }.
// Unlike testQuery it doesn't wait out a fixed window, so latency is the real round trip.
export function probe(ip, query, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rawWaiters.set(
        ip,
        (rawWaiters.get(ip) || []).filter((f) => f !== feed),
      );
      resolve(value);
    };
    const feed = (text) => finish({ ok: true, text, ms: Date.now() - t0 });
    const timer = setTimeout(() => finish({ ok: false, ms: Date.now() - t0 }), timeoutMs);
    rawWaiters.set(ip, [...(rawWaiters.get(ip) || []), feed]);
    send(ip, `CMD=START&UNIT.ID=ALL&${query}&CMD=END`);
  });
}

// ----- blank screen / on-screen message (decoder VIDEO.OUTPUT and VIDEO.OSD_TEXT, per the Visionary manual) -----
// OUTPUT: NORMAL = picture, STANDBY = black screen, LOGO = splash, OFF = HDMI output disabled. The decoder sets
// it back to NORMAL by itself whenever it is tuned to a source. OSD_TEXT is a short text overlay.
export const SCREEN_MODES = { picture: "NORMAL", black: "STANDBY", logo: "LOGO" };

export const OSD_TEXT_PATTERN = /^[A-Za-z0-9 .,:;!?'()/-]{1,80}$/;

// no & or = so text can never add another command
function osdDecode(raw) {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " ")).trim();
  } catch {
    return raw.trim(); // malformed % escape: use the text as typed
  }
}

// null = no usable reply
export async function readOutput(ip) {
  const r = await probe(ip, "QUERY.KEY=VIDEO.OUTPUT", QUERY_TIMEOUT_MS);
  const m = r.ok && r.text.match(/VIDEO\.OUTPUT=([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : null;
}

async function readOsd(ip) {
  const r = await probe(ip, "QUERY.KEY=VIDEO.OSD_TEXT", QUERY_TIMEOUT_MS);
  const m = r.ok && r.text.match(/VIDEO\.OSD_TEXT=([^&\r\n]*)/);
  return m ? osdDecode(m[1]) : null;
}

// action: picture | black | logo | message | clear-message | status. Each command is confirmed by reading it
// back, like a source switch. Resolves { ok, output, osd }; throws with a message fit to show to a user.
export async function applyScreen(decoder, action, text) {
  const ip = decoder.ip;
  if (screenBusy.has(ip)) throw new Error("A screen command is already running for this screen");
  screenBusy.add(ip);
  try {
    const remember = (patch) => screenState.set(ip, { ...(screenState.get(ip) || {}), ...patch });
    if (action === "status") {
      const output = await readOutput(ip);
      const osd = await readOsd(ip);
      if (output !== null) remember({ output });
      if (osd !== null) remember({ osd });
      return { ok: output !== null || osd !== null, output, osd };
    }
    let command;
    let confirm;
    if (SCREEN_MODES[action]) {
      const want = SCREEN_MODES[action];
      command = `VIDEO.OUTPUT=${want}`;
      confirm = async () => ((await readOutput(ip)) === want ? { output: want } : null);
    } else {
      const want = action === "message" ? text : "";
      command = `VIDEO.OSD_TEXT=${want}`;
      confirm = async () => ((await readOsd(ip)) === want ? { osd: want } : null);
    }
    send(ip, `CMD=START&UNIT.ID=ALL&${command}&CMD=END`);
    for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS; attempt++) {
      await sleep(attempt === 1 ? CONFIRM_DELAY_MS : CONFIRM_RETRY_MS);
      const got = await confirm();
      if (got) {
        remember(got);
        return { ok: true, ...got };
      }
    }
    return { ok: false };
  } finally {
    screenBusy.delete(ip);
  }
}

// ----- encoder input switching (STREAM.VIDEO on E5200 encoders: AUTO, HDMI1, HDMI2, USB-C, per the manual) -----
// null = no usable reply
async function readInput(ip) {
  const r = await probe(ip, "QUERY.KEY=STREAM.VIDEO", QUERY_TIMEOUT_MS);
  const m = r.ok && r.text.match(/STREAM\.VIDEO=([A-Za-z0-9-]+)/);
  return m ? m[1].toUpperCase() : null;
}

// input = one of inputChoices to change it, or null to just read it. A change is confirmed by reading it
// back, like a source switch. Resolves { ok, input }; throws with a message fit to show to a user.
export async function applyInput(encoder, input) {
  const ip = encoder.ip;
  if (inputBusy.has(ip)) throw new Error("An input change is already running for this source");
  inputBusy.add(ip);
  try {
    if (input === null) {
      const current = await readInput(ip);
      if (current) inputState.set(ip, { input: current });
      return { ok: current !== null, input: current };
    }
    send(ip, `CMD=START&UNIT.ID=ALL&STREAM.VIDEO=${input}&CMD=END`);
    let current = null;
    for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS; attempt++) {
      await sleep(attempt === 1 ? CONFIRM_DELAY_MS : CONFIRM_RETRY_MS);
      current = await readInput(ip);
      if (current) inputState.set(ip, { input: current });
      if (current === input) return { ok: true, input: current };
    }
    return { ok: false, input: current };
  } finally {
    inputBusy.delete(ip);
  }
}

// What a person's Status screen covers: everything for an admin; for a Manager, the screens of the groups
// they manage and the sources those groups use (a group on "all sources" brings every source).
export function healthScope(user) {
  if (user.role === "admin")
    return { decoders: config.decoders, encoders: config.encoders, key: "all" };
  const decIps = new Set();
  const srcIps = new Set();
  let allSources = false;
  for (const g of Object.values(store.groups)) {
    if (!(g.managers || []).includes(user.username)) continue;
    for (const ip of groupDecoderSet(g)) decIps.add(ip);
    if (g.sources === "all") allSources = true;
    else for (const ip of g.sources || []) srcIps.add(ip);
  }
  return {
    decoders: config.decoders.filter((d) => decIps.has(d.ip)),
    encoders: config.encoders.filter((e) => allSources || srcIps.has(e.ip)),
    key: `user:${user.username}`,
  };
}

// Health check: asks the screens and sources in `scope` for their model, all at once (capped), and remembers
// who answered, how fast, and what model. Callers with the same scope arriving during a run share it, and
// anyone arriving during a full (admin) run just waits for that.
export function runHealthCheck(scope) {
  if (healthRuns.has(scope.key)) return healthRuns.get(scope.key);
  if (healthRuns.has("all")) return healthRuns.get("all");
  const run = (async () => {
    await mapLimited([...scope.decoders, ...scope.encoders], HEALTH_CONCURRENCY, async (d) => {
      const r = await probe(d.ip, "QUERY.KEY=UNIT.MODEL", HEALTH_PROBE_MS);
      const model = r.ok ? (r.text.match(/UNIT\.MODEL=([^&\s]+)/) || [])[1] || null : null;
      healthCache.set(d.ip, { ok: r.ok, ms: r.ok ? r.ms : null, model, at: Date.now() });
      if (!r.ok) reachability.set(d.ip, false);
    });
  })().finally(() => {
    healthRuns.delete(scope.key);
  });
  healthRuns.set(scope.key, run);
  return run;
}

function healthRow(kind, d) {
  const h = healthCache.get(d.ip);
  const known = lastKnown.get(d.ip);
  const row = {
    kind,
    name: d.name,
    ip: d.ip,
    reachable: reachability.has(d.ip) ? reachability.get(d.ip) : h ? h.ok : null, // null = never asked
    lastReply: lastReply.get(d.ip) || null,
    model: h ? h.model : null,
    ms: h ? h.ms : null,
    checkedAt: h ? h.at : null,
  };
  if (kind === "decoder") {
    row.space = d.space;
    const src = known && config.encoders.find((e) => e.ip === known.host);
    row.source = src ? src.name : known ? known.host : null;
  }
  return row;
}

export function healthReport(scope) {
  const devices = [
    ...scope.decoders.map((d) => healthRow("decoder", d)),
    ...scope.encoders.map((e) => healthRow("encoder", e)),
  ];
  const count = (v) => devices.filter((r) => r.reachable === v).length;
  let checkedAt = null; // the latest time any of these devices was asked
  for (const r of devices)
    if (r.checkedAt && (!checkedAt || r.checkedAt > checkedAt)) checkedAt = r.checkedAt;
  return {
    checkedAt,
    running: healthRuns.has(scope.key) || healthRuns.has("all"),
    summary: {
      total: devices.length,
      answering: count(true),
      notAnswering: count(false),
      unknown: count(null),
    },
    devices,
  };
}

// Switch a decoder, then confirm by query. The ack alone is not proof it applied.
export async function routeDecoder(ip, encoderIp) {
  if (busy.has(ip)) throw new Error("A route is already in progress for this decoder");
  busy.add(ip);
  try {
    send(
      ip,
      `CMD=START&UNIT.ID=ALL&STREAM.HOST=${encoderIp}&VW.ACTIVE=FALSE&STREAM.CONNECT=TRUE&CMD=END`,
    );
    let reported = null;
    for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS; attempt++) {
      await sleep(attempt === 1 ? CONFIRM_DELAY_MS : CONFIRM_RETRY_MS);
      reported = await queryHost(ip);
      if (reported) lastKnown.set(ip, { host: reported, at: Date.now() });
      if (reported === encoderIp) {
        logEvent(`${ip} CONFIRMED: tuned to ${reported}`);
        screenState.set(ip, { ...(screenState.get(ip) || {}), output: "NORMAL" }); // the decoder resets blanking when it is tuned
        return { confirmed: true, host: reported };
      }
      logEvent(`${ip} attempt ${attempt}: reports ${reported}, expected ${encoderIp}`);
    }
    return { confirmed: false, host: reported };
  } finally {
    busy.delete(ip);
  }
}

// One serial exchange: connect to the decoder's serial-over-IP port, send the command, wait for a
// complete reply, close. Rejects with a plain-language message when the TV can't be reached.
function tvExchange(ip, proto, text) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const sock = net.connect({ host: ip, port: TV_SERIAL_PORT });
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(buf);
    };
    const timer = setTimeout(
      () => finish(new Error(buf ? "Incomplete reply from the TV" : "No reply from the TV")),
      TV_TIMEOUT_MS,
    );
    sock.setEncoding("latin1");
    sock.on("connect", () => {
      logDebug(`TV TX -> ${ip}:${TV_SERIAL_PORT} ${JSON.stringify(text)}`);
      sock.write(text, "latin1");
    });
    sock.on("data", (d) => {
      buf += d;
      logDebug(`TV RX <- ${ip} ${JSON.stringify(buf)}`);
      if (proto.complete(buf)) finish(null);
    });
    sock.on("error", (e) => {
      const refused = e.code === "ECONNREFUSED";
      finish(
        new Error(
          refused
            ? "The decoder refused the serial connection (serial over IP may be off)"
            : `Could not reach the decoder (${e.code || e.message})`,
        ),
      );
    });
    sock.on("close", () =>
      finish(buf ? null : new Error("The decoder closed the connection without a reply")),
    );
  });
}

// action: "on" | "off" | "status". Resolves { on, raw }; throws with a message fit to show to a user.
export async function tvPowerCommand(decoder, action, protoName) {
  const proto = TV_PROTOCOLS[protoName];
  const text = proto.command[action](decoder.tvSetId || proto.defaultSetId);
  if (tvBusy.has(decoder.ip)) throw new Error("A power command is already running for this screen");
  tvBusy.add(decoder.ip);
  try {
    let raw = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        raw = await tvExchange(decoder.ip, proto, text);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        logEvent(`TV ${decoder.ip} attempt ${attempt} failed: ${e.message}`);
        if (attempt === 1) await sleep(TV_RETRY_DELAY_MS);
      }
    }
    if (lastErr) throw lastErr;
    const parsed = proto.parse(raw);
    if (!parsed) throw new Error("The TV sent a reply this app doesn't understand");
    if (!parsed.ok)
      throw new Error("The TV rejected the command (it may be busy, or not support it)");
    tvState.set(decoder.ip, { on: parsed.on, at: Date.now() });
    return { on: parsed.on, raw };
  } finally {
    tvBusy.delete(decoder.ip);
  }
}

udp.on("message", (msg, rinfo) => {
  const text = msg.toString();
  logDebug(`RX <- ${rinfo.address}:${rinfo.port} ${text}`);
  (rawWaiters.get(rinfo.address) || []).forEach((f) => f(text));
  reachability.set(rinfo.address, true); // any reply at all means the decoder is reachable
  lastReply.set(rinfo.address, Date.now());
  const status = (text.match(/API\.STATUS=([A-Za-z_]+)/) || [])[1];
  if (status !== "SUCCESS_QUERY_KEY") return; // plain SUCCESS is only an ack
  const host = (text.match(/STREAM\.HOST=[A-Za-z_]*(\d+\.\d+\.\d+\.\d+)/) || [])[1] || null;
  if (host) lastKnown.set(rinfo.address, { host, at: Date.now() });
  const waiters = queryWaiters.get(rinfo.address) || [];
  queryWaiters.delete(rinfo.address);
  waiters.forEach((f) => f(host));
});

udp.on("error", (err) => logEvent(`UDP error: ${err.message}`));

udp.bind();
