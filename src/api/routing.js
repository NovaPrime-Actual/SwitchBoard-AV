// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// ROUTING API for SwitchBoard-AV
// Description: What a signed-in person can see and do: screen status, routing, inputs, screen modes, TV power.
// ===========================================

import { BATCH_CONCURRENCY, DIAG_QUERIES, MAX_BATCH_SCREENS, TV_PROTOCOLS } from "../config.js";
import {
  OSD_TEXT_PATTERN,
  SCREEN_MODES,
  applyInput,
  applyScreen,
  queryHost,
  readOutput,
  routeDecoder,
  testQuery,
  tvPowerCommand,
} from "../decoders.js";
import { config } from "../devicelist.js";
import { readJsonOrRefuse, reply, snapshot } from "../http.js";
import {
  inputControlEncoderSet,
  multiSwitchDecoderSet,
  screenControlDecoderSet,
  sourceFitsScreen,
  tvPowerDecoderSet,
  visibleDecoderSet,
  visibleSourceSet,
} from "../scoping.js";
import { reachability, screenBusy, screenState } from "../state.js";
import { logActivity } from "../store.js";
import { isValidIp, mapLimited } from "../util.js";

export async function handleRefresh(req, res, user) {
  const decIps = visibleDecoderSet(user);
  const targets = config.decoders.filter((d) => decIps.has(d.ip) && isValidIp(d.ip));
  await Promise.all(targets.map((d) => queryHost(d.ip)));
  // also read each answering screen's output mode, so a blanked screen is shown as blank
  await Promise.all(
    targets
      .filter((d) => reachability.get(d.ip) !== false && !screenBusy.has(d.ip))
      .map(async (d) => {
        const output = await readOutput(d.ip);
        if (output) screenState.set(d.ip, { ...(screenState.get(d.ip) || {}), output });
      }),
  );
  return reply(res, 200, snapshot(user));
}

export async function handleRoute(req, res, user) {
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  // One screen ({ decoderIp }) or several at once ({ decoderIps: [...] }). Every screen is checked against
  // the caller's access first; if any is outside it, nothing is switched.
  const wanted = Array.isArray(body.decoderIps) ? body.decoderIps : [body.decoderIp];
  const ips = [...new Set(wanted.map(String))];
  if (ips.length === 0) return reply(res, 400, { error: "No screens chosen" });
  if (ips.length > MAX_BATCH_SCREENS)
    return reply(res, 400, { error: `Choose at most ${MAX_BATCH_SCREENS} screens at a time` });
  const decoders = ips.map((ip) => config.decoders.find((d) => d.ip === ip));
  const encoder = config.encoders.find((e) => e.ip === body.encoderIp);
  if (decoders.some((d) => !d) || !encoder)
    return reply(res, 400, { error: "Unknown decoder or encoder" });
  for (const d of decoders)
    if (!isValidIp(d.ip))
      return reply(res, 400, { error: `${d.name} has no valid IP in devices.json` });
  if (!isValidIp(encoder.ip))
    return reply(res, 400, { error: `${encoder.name} has no valid IP in devices.json` });

  const visible = visibleDecoderSet(user);
  if (decoders.some((d) => !visible.has(d.ip))) {
    return reply(res, 403, {
      error:
        decoders.length === 1
          ? "That screen is outside your access"
          : "One of those screens is outside your access",
    });
  }
  if (!visibleSourceSet(user).has(encoder.ip))
    return reply(res, 403, { error: "That source is outside your access" });
  if (decoders.some((d) => !sourceFitsScreen(encoder, d)))
    return reply(res, 403, { error: `${encoder.name} is only for screens in ${encoder.space}` });
  if (decoders.length > 1) {
    const multi = multiSwitchDecoderSet(user);
    if (decoders.some((d) => !multi.has(d.ip)))
      return reply(res, 403, {
        error: "You don't have permission to switch several screens at once",
      });
  }

  const batch = decoders.length > 1;
  const results = await mapLimited(decoders, BATCH_CONCURRENCY, async (d) => {
    const entry = {
      type: "route",
      username: user.username,
      decoder: d.name,
      decoderIp: d.ip,
      encoder: encoder.name,
      encoderIp: encoder.ip,
      ...(batch ? { batch: decoders.length } : {}),
    };
    try {
      const r = await routeDecoder(d.ip, encoder.ip);
      logActivity({ ...entry, result: r.confirmed ? "confirmed" : "not confirmed" });
      return { decoderIp: d.ip, name: d.name, confirmed: r.confirmed, host: r.host };
    } catch (e) {
      logActivity({ ...entry, result: `failed: ${e.message}` });
      return { decoderIp: d.ip, name: d.name, confirmed: false, host: null, error: e.message };
    }
  });
  return reply(res, 200, {
    confirmed: results.every((r) => r.confirmed),
    host: results[0].host,
    results,
    snapshot: snapshot(user),
  });
}

// body: { decoderIps: [...] (or decoderIp), action: "picture" | "black" | "logo" | "message" | "clear-message" | "status", text }.
// Every screen is checked against the caller's screen-control access first; if any is outside it nothing is sent.
// "status" reads one screen's output mode and message without changing anything.
export async function handleScreen(req, res, user) {
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const action = body.action;
  if (![...Object.keys(SCREEN_MODES), "message", "clear-message", "status"].includes(action))
    return reply(res, 400, { error: "Unknown action" });
  const wanted = Array.isArray(body.decoderIps) ? body.decoderIps : [body.decoderIp];
  const ips = [...new Set(wanted.map(String))];
  if (ips.length === 0) return reply(res, 400, { error: "No screens chosen" });
  if (ips.length > MAX_BATCH_SCREENS)
    return reply(res, 400, { error: `Choose at most ${MAX_BATCH_SCREENS} screens at a time` });
  if (action === "status" && ips.length !== 1)
    return reply(res, 400, { error: "Status is read for one screen at a time" });
  const decoders = ips.map((ip) => config.decoders.find((d) => d.ip === ip));
  if (decoders.some((d) => !d)) return reply(res, 400, { error: "Unknown screen" });
  let text = "";
  if (action === "message") {
    text = String(body.text || "").trim();
    if (!OSD_TEXT_PATTERN.test(text))
      return reply(res, 400, {
        error:
          "A message may use letters, numbers, spaces and . , : ; ! ? ' ( ) / - (up to 80 characters)",
      });
  }
  const visible = visibleDecoderSet(user);
  const allowed = screenControlDecoderSet(user);
  if (decoders.some((d) => !visible.has(d.ip)))
    return reply(res, 403, { error: "That screen is outside your access" });
  if (decoders.some((d) => !allowed.has(d.ip)))
    return reply(res, 403, { error: "You don't have screen control for that screen" });
  if (decoders.length > 1) {
    const multi = multiSwitchDecoderSet(user);
    if (decoders.some((d) => !multi.has(d.ip)))
      return reply(res, 403, { error: "You don't have permission to use several screens at once" });
  }

  const batch = decoders.length > 1;
  const results = await mapLimited(decoders, BATCH_CONCURRENCY, async (d) => {
    const entry = {
      type: "screen",
      username: user.username,
      decoder: d.name,
      decoderIp: d.ip,
      action,
      ...(text ? { text } : {}),
      ...(batch ? { batch: decoders.length } : {}),
    };
    try {
      const r = await applyScreen(d, action, text);
      if (action !== "status")
        logActivity({ ...entry, result: r.ok ? "confirmed" : "not confirmed" });
      return { decoderIp: d.ip, name: d.name, ...r };
    } catch (e) {
      if (action !== "status") logActivity({ ...entry, result: `failed: ${e.message}` });
      return { decoderIp: d.ip, name: d.name, ok: false, error: e.message };
    }
  });
  return reply(res, 200, { ok: results.every((r) => r.ok), results, snapshot: snapshot(user) });
}

// body: { encoderIp, input } changes the encoder's input; { encoderIp } alone reads it. This changes what EVERY
// screen watching that source sees, so it needs its own group permission, and the encoder has to offer input
// switching (Devices > Sources).
export async function handleSourceInput(req, res, user) {
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const encoder = config.encoders.find((e) => e.ip === body.encoderIp);
  if (!encoder) return reply(res, 400, { error: "Unknown source" });
  if (!Array.isArray(encoder.inputs) || encoder.inputs.length === 0)
    return reply(res, 400, { error: "Input switching isn't set up for this source" });
  if (!visibleSourceSet(user).has(encoder.ip))
    return reply(res, 403, { error: "That source is outside your access" });
  if (!inputControlEncoderSet(user).has(encoder.ip))
    return reply(res, 403, { error: "You don't have input control for this source" });
  let input = null;
  if (body.input !== undefined) {
    input = String(body.input);
    if (!encoder.inputs.includes(input))
      return reply(res, 400, { error: "That input isn't offered for this source" });
  }
  const entry = {
    type: "source_input",
    username: user.username,
    encoder: encoder.name,
    encoderIp: encoder.ip,
    input,
  };
  try {
    const r = await applyInput(encoder, input);
    if (input !== null) logActivity({ ...entry, result: r.ok ? "confirmed" : "not confirmed" });
    return reply(res, 200, { ok: r.ok, input: r.input, snapshot: snapshot(user) });
  } catch (e) {
    if (input !== null) logActivity({ ...entry, result: `failed: ${e.message}` });
    return reply(res, 502, { error: e.message });
  }
}

// body: { decoderIp, action: "on" | "off" | "status" }. Admins may add probe: true with action "status"
// to test any decoder's serial link (before it is flagged in devices.json); the raw reply comes back.
export async function handleTvPower(req, res, user) {
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const decoder = config.decoders.find((d) => d.ip === body.decoderIp);
  if (!decoder || !isValidIp(decoder.ip)) return reply(res, 400, { error: "Unknown decoder" });
  const action = body.action;
  if (!["on", "off", "status"].includes(action))
    return reply(res, 400, { error: "Action must be on, off or status" });

  const probe = user.role === "admin" && body.probe === true && action === "status";
  let protoName = decoder.tvPower;
  if (probe) {
    if (!TV_PROTOCOLS[protoName]) protoName = "lg";
  } else {
    if (!TV_PROTOCOLS[protoName])
      return reply(res, 400, { error: "TV power isn't set up for this screen" });
    if (!visibleDecoderSet(user).has(decoder.ip))
      return reply(res, 403, { error: "That screen is outside your access" });
    if (!tvPowerDecoderSet(user).has(decoder.ip))
      return reply(res, 403, { error: "You don't have TV power access for this screen" });
  }

  const entry = {
    type: "tv_power",
    username: user.username,
    decoder: decoder.name,
    decoderIp: decoder.ip,
    action: probe ? "probe" : action,
  };
  try {
    const r = await tvPowerCommand(decoder, action, protoName);
    // Routine status checks (the popup opening) aren't logged; commands and admin probes are.
    if (action !== "status" || probe) logActivity({ ...entry, result: r.on ? "TV on" : "TV off" });
    const out = { on: r.on, snapshot: snapshot(user) };
    if (user.role === "admin") out.raw = r.raw;
    return reply(res, 200, out);
  } catch (e) {
    if (action !== "status" || probe) logActivity({ ...entry, result: `failed: ${e.message}` });
    return reply(res, 502, { error: e.message });
  }
}

export async function handleTestQuery(req, res, user) {
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  // Looked up in the device list by IP (screens, then sources): a client cannot aim a query at an arbitrary address.
  const device =
    config.decoders.find((d) => d.ip === body.deviceIp) ||
    config.encoders.find((e) => e.ip === body.deviceIp);
  if (!device || !isValidIp(device.ip))
    return reply(res, 400, { error: "Unknown device or no valid IP" });
  const key = String(body.key || "").trim();
  if (body.diag) {
    if (!DIAG_QUERIES.includes(body.diag))
      return reply(res, 400, { error: "Not an allowed diagnostics query" });
    const r = await testQuery(device.ip, `QUERY.${body.diag}=TRUE`);
    logActivity({
      type: "test_query",
      username: user.username,
      deviceIp: device.ip,
      query: `QUERY.${body.diag}=TRUE`,
    });
    return reply(res, 200, r);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key))
    return reply(res, 400, { error: "Key may only use letters, numbers, . _ -" });
  const r = await testQuery(device.ip, `QUERY.KEY=${key}`);
  logActivity({
    type: "test_query",
    username: user.username,
    deviceIp: device.ip,
    query: `QUERY.KEY=${key}`,
  });
  return reply(res, 200, r);
}
