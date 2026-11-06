// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// DEVICES API for SwitchBoard-AV
// Description: Admin only: the device list (screens, sources, spaces, paste import, restore, history).
// ===========================================

import { DECODER_PORT, HISTORY_CHOICES, INPUT_CHOICES, TV_PROTOCOLS, WEB_PORT } from "../config.js";
import { probe, tvPowerCommand } from "../decoders.js";
import {
  HttpError,
  cleanDecoder,
  cleanEncoder,
  commitDevices,
  config,
  deviceErrors,
  deviceHistory,
  deviceListErrors,
  deviceListSource,
  historyKeep,
  isStrictIp,
  mergeSpaces,
  trimDeviceHistory,
} from "../devicelist.js";
import { readJson, reply } from "../http.js";
import { logEvent } from "../log.js";
import { logActivity, saveStore, store } from "../store.js";

const DEVICE_FIELDS = {
  decoders: ["name", "space", "ip", "tvPower", "tvSetId"],
  encoders: ["name", "ip", "inputs", "space"],
};

function parseDevicePaste(kind, text) {
  const rows = [];
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length > 500) throw new HttpError(400, "Paste at most 500 lines at a time");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const cells = (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) => c.trim());
    if (i === 0 && /^name$/i.test(cells[0])) return; // header row from a spreadsheet
    if (kind === "decoders") {
      const [name, space, ip, tvPower, tvSetId] = cells;
      const tv = /^(none|-)?$/i.test(tvPower || "") ? "" : String(tvPower).toLowerCase();
      rows.push({ line: i + 1, dev: cleanDecoder({ name, space, ip, tvPower: tv, tvSetId }) });
    } else {
      const [name, ip] = cells;
      rows.push({ line: i + 1, dev: cleanEncoder({ name, ip }) });
    }
  });
  return rows;
}

const MAX_DEVICES_IN_FILE = 2000;

// Reads the text of an uploaded devices.json into cleaned screens, sources and spaces, or says in plain
// words why it can't be used.
function parseDeviceFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new HttpError(
      400,
      "That file is not valid JSON. Use a devices.json downloaded from this app.",
      { cause: err },
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new HttpError(400, "That file does not look like a device list.");
  const decoders = data.decoders === undefined ? [] : data.decoders;
  const encoders = data.encoders === undefined ? [] : data.encoders;
  if (!Array.isArray(decoders) || !Array.isArray(encoders))
    throw new HttpError(
      400,
      "That file does not look like a device list (screens and sources should be lists).",
    );
  if (decoders.length === 0 && encoders.length === 0)
    throw new HttpError(400, "That file has no screens or sources in it, so it was not used.");
  if (decoders.length > MAX_DEVICES_IN_FILE || encoders.length > MAX_DEVICES_IN_FILE)
    throw new HttpError(400, "That file has too many screens or sources.");
  if ([...decoders, ...encoders].some((d) => !d || typeof d !== "object" || Array.isArray(d))) {
    throw new HttpError(400, "Every screen and source in the file needs a name and an IP address.");
  }
  const spaces = Array.isArray(data.spaces) ? data.spaces.slice(0, 500).map((s) => String(s)) : [];
  return { decoders: decoders.map(cleanDecoder), encoders: encoders.map(cleanEncoder), spaces };
}

// What replacing the current list with this one would change, for the admin to read before confirming.
function summarizeDeviceFile(list) {
  const nowScreens = new Set(config.decoders.map((d) => d.ip));
  const nowSources = new Set(config.encoders.map((e) => e.ip));
  const newScreens = new Set(list.decoders.map((d) => d.ip));
  const newSources = new Set(list.encoders.map((e) => e.ip));
  const count = (a, notIn) => [...a].filter((ip) => !notIn.has(ip)).length;
  // group settings that name a screen or source by IP which the new list doesn't have
  let groupSettingsMissing = 0;
  for (const g of Object.values(store.groups)) {
    for (const ip of [...(g.decoders || []), ...(g.excludeDecoders || [])])
      if (!newScreens.has(ip)) groupSettingsMissing++;
    if (Array.isArray(g.sources))
      for (const ip of g.sources) if (!newSources.has(ip)) groupSettingsMissing++;
  }
  return {
    screens: list.decoders.length,
    sources: list.encoders.length,
    spaces: mergeSpaces(list.decoders, list.spaces, list.encoders).length,
    screensAdded: count(newScreens, nowScreens),
    screensRemoved: count(nowScreens, newScreens),
    sourcesAdded: count(newSources, nowSources),
    sourcesRemoved: count(nowSources, newSources),
    groupSettingsMissing,
  };
}

export async function handleAdminDevices(req, res, user, rest) {
  if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
  try {
    const kind = rest[0]; // "decoders" | "encoders" | other verbs
    const method = req.method;

    if (rest.length === 0 && method === "GET") {
      return reply(res, 200, {
        decoders: config.decoders,
        encoders: config.encoders,
        spaces: config.spaces,
        tvProtocols: Object.keys(TV_PROTOCOLS),
        source: deviceListSource,
        historyKeep: historyKeep(),
        historyChoices: HISTORY_CHOICES,
        history: deviceHistory
          .map((h) => ({
            at: h.at,
            by: h.by,
            reason: h.reason,
            screens: h.decoders.length,
            sources: h.encoders.length,
          }))
          .reverse(),
      });
    }

    // How many earlier versions of the list to keep. Choosing fewer than are stored drops the oldest ones now.
    if (kind === "history-limit" && method === "POST") {
      const body = await readJson(req);
      const keep = body.keep; // must be a number, not text or a list
      if (!Number.isInteger(keep) || !HISTORY_CHOICES.includes(keep))
        throw new HttpError(400, `Choose one of: ${HISTORY_CHOICES.join(", ")}`);
      const dropped = Math.max(0, deviceHistory.length - keep);
      store.settings = { ...(store.settings || {}), deviceHistoryKeep: keep };
      saveStore();
      if (dropped) trimDeviceHistory(keep);
      logActivity({
        type: "admin_device",
        by: user.username,
        detail:
          `keep the last ${keep} list changes` + (dropped ? ` (dropped ${dropped} older)` : ""),
      });
      return reply(res, 200, { ok: true, historyKeep: keep, dropped });
    }

    if (kind === "export" && method === "GET") {
      const body = JSON.stringify(
        {
          port: WEB_PORT,
          decoderPort: DECODER_PORT,
          decoders: config.decoders,
          encoders: config.encoders,
          spaces: config.spaces,
        },
        null,
        2,
      );
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="devices.json"',
      });
      return res.end(body);
    }

    if (
      (kind === "decoders" || kind === "encoders") &&
      ["POST", "PATCH", "DELETE"].includes(method)
    ) {
      const isDec = kind === "decoders";
      const list = isDec ? config.decoders : config.encoders;
      const clean = isDec ? cleanDecoder : cleanEncoder;
      const noun = isDec ? "screen" : "source";
      const ipKey = isDec ? "decoderIps" : "encoderIps";
      const body = method === "DELETE" ? {} : await readJson(req);
      const pick = Object.fromEntries(
        DEVICE_FIELDS[kind].filter((f) => f in body).map((f) => [f, body[f]]),
      );
      if (!isDec && "inputs" in pick) {
        if (!Array.isArray(pick.inputs)) throw new HttpError(400, "inputs must be a list");
        const bad = pick.inputs.filter((v) => !INPUT_CHOICES.includes(v));
        if (bad.length)
          throw new HttpError(400, `Unknown input "${bad[0]}" (use ${INPUT_CHOICES.join(", ")})`);
      }

      let next;
      let reason;
      const cascade = {};
      if (method === "POST") {
        const dev = clean(pick);
        next = [...list, dev];
        reason = `add ${noun} ${dev.name} (${dev.ip})`;
      } else {
        const ip = decodeURIComponent(rest[1] || "");
        const idx = list.findIndex((d) => d.ip === ip);
        if (idx < 0) throw new HttpError(404, `No ${noun} with IP ${ip}`);
        const old = list[idx];
        if (method === "PATCH") {
          const dev = clean({ ...old, ...pick });
          next = list.map((d, i) => (i === idx ? dev : d));
          if (dev.ip !== old.ip) cascade[ipKey] = new Map([[old.ip, dev.ip]]);
          reason = `edit ${noun} ${old.name}${dev.ip !== old.ip ? ` (IP ${old.ip} -> ${dev.ip})` : ""}`;
        } else {
          next = list.filter((_, i) => i !== idx);
          cascade[ipKey] = new Map([[old.ip, null]]);
          reason = `delete ${noun} ${old.name} (${old.ip})`;
        }
      }
      const r = commitDevices(isDec ? next : config.decoders, isDec ? config.encoders : next, {
        by: user.username,
        reason,
        cascade,
      });
      return reply(res, 200, {
        ok: true,
        groupsUpdated: r.groupsUpdated,
        decoders: config.decoders,
        encoders: config.encoders,
      });
    }

    // add a space on its own (it can be empty; screens are moved into it from the screen form)
    if (kind === "spaces" && rest.length === 1 && method === "POST") {
      const body = await readJson(req);
      const name = String(body.name || "").trim();
      if (!name) throw new HttpError(400, "Space name required");
      if (name.length > 64) throw new HttpError(400, "Space name is longer than 64 characters");
      if (config.spaces.some((s) => s.toLowerCase() === name.toLowerCase()))
        throw new HttpError(400, `A space called "${name}" already exists`);
      commitDevices(config.decoders, config.encoders, {
        by: user.username,
        reason: `add space ${name}`,
        spaces: [...config.spaces, name],
      });
      return reply(res, 200, { ok: true, spaces: config.spaces });
    }

    if (kind === "spaces" && rest[1] === "rename" && method === "POST") {
      const body = await readJson(req);
      const from = String(body.from || "").trim();
      const to = String(body.to || "").trim();
      if (!to) throw new HttpError(400, "New space name required");
      if (to.length > 64) throw new HttpError(400, "Space name is longer than 64 characters");
      if (!config.spaces.includes(from)) throw new HttpError(404, `No space called "${from}"`);
      if (from === to) throw new HttpError(400, "That is already the name");
      const next = config.decoders.map((d) => (d.space === from ? { ...d, space: to } : d));
      const nextSources = config.encoders.map((e) => (e.space === from ? { ...e, space: to } : e));
      const r = commitDevices(next, nextSources, {
        by: user.username,
        reason: `rename space ${from} -> ${to}`,
        cascade: { spaces: new Map([[from, to]]) },
        spaces: config.spaces.map((s) => (s === from ? to : s)),
      });
      return reply(res, 200, { ok: true, groupsUpdated: r.groupsUpdated });
    }

    // delete a space; only an empty one, so a screen is never left without a space by accident
    if (kind === "spaces" && rest.length === 2 && method === "DELETE") {
      const name = decodeURIComponent(rest[1]);
      if (!config.spaces.includes(name)) throw new HttpError(404, `No space called "${name}"`);
      const n = config.decoders.filter((d) => d.space === name).length;
      if (n > 0)
        throw new HttpError(
          400,
          `"${name}" still has ${n} screen${n === 1 ? "" : "s"}. Move or delete them first`,
        );
      const local = config.encoders.filter((e) => e.space === name).length;
      if (local > 0)
        throw new HttpError(
          400,
          `"${name}" still has ${local} local source${local === 1 ? "" : "s"}. Move or delete them first`,
        );
      const r = commitDevices(config.decoders, config.encoders, {
        by: user.username,
        reason: `delete space ${name}`,
        cascade: { spaces: new Map([[name, null]]) },
        spaces: config.spaces.filter((s) => s !== name),
      });
      return reply(res, 200, { ok: true, groupsUpdated: r.groupsUpdated });
    }

    if (kind === "import" && method === "POST") {
      const body = await readJson(req, 300000); // a pasted list of 500 lines is about 50 KB
      const which = body.kind === "encoders" ? "encoders" : "decoders";
      const rows = parseDevicePaste(which, body.text);
      if (rows.length === 0) throw new HttpError(400, "Nothing to import");
      const noun = which === "decoders" ? "screen" : "source";
      const taken = new Map([...config.decoders, ...config.encoders].map((d) => [d.ip, d.name]));
      const seenLine = new Map();
      const errors = [];
      for (const { line, dev } of rows) {
        for (const e of deviceErrors(dev, noun)) errors.push(`Line ${line}: ${e}`);
        if (!isStrictIp(dev.ip)) continue;
        if (taken.has(dev.ip))
          errors.push(`Line ${line}: IP ${dev.ip} is already used by ${taken.get(dev.ip)}`);
        else if (seenLine.has(dev.ip))
          errors.push(`Line ${line}: IP ${dev.ip} already appears on line ${seenLine.get(dev.ip)}`);
        else seenLine.set(dev.ip, line);
      }
      const devs = rows.map((r) => r.dev);
      if (errors.length || body.dryRun)
        return reply(res, 200, { ok: errors.length === 0, rows: devs, errors });
      const decoders = which === "decoders" ? [...config.decoders, ...devs] : config.decoders;
      const encoders = which === "encoders" ? [...config.encoders, ...devs] : config.encoders;
      commitDevices(decoders, encoders, {
        by: user.username,
        reason: `import ${devs.length} ${noun}${devs.length === 1 ? "" : "s"}`,
      });
      return reply(res, 200, { ok: true, added: devs.length, errors: [] });
    }

    if (kind === "test" && method === "POST") {
      // Read-only: a UDP query, plus (if asked) a TV power status read over serial. Never changes anything.
      const body = await readJson(req);
      const ip = String(body.ip || "").trim();
      if (!isStrictIp(ip)) throw new HttpError(400, "That is not a valid IP address");
      const r = await probe(ip, "QUERY.KEY=UNIT.MODEL", 2000);
      const out = {
        reachable: r.ok,
        ms: r.ok ? r.ms : null,
        reply: r.ok ? r.text.trim().slice(0, 200) : null,
      };
      if (body.tv) {
        try {
          const tv = await tvPowerCommand({ ip, tvSetId: body.tvSetId }, "status", "lg");
          out.tv = { ok: true, on: tv.on };
        } catch (e) {
          out.tv = { ok: false, error: e.message };
        }
      }
      return reply(res, 200, out);
    }

    if (kind === "restore" && method === "POST") {
      const body = await readJson(req);
      const snap = deviceHistory.find((h) => h.at === body.at);
      if (!snap) throw new HttpError(404, "That snapshot is no longer available");
      commitDevices(snap.decoders.map(cleanDecoder), snap.encoders.map(cleanEncoder), {
        by: user.username,
        reason: `restore the list as it was before: ${snap.reason}`,
        spaces: snap.spaces || [],
      });
      return reply(res, 200, { ok: true, decoders: config.decoders, encoders: config.encoders });
    }

    // Replace the whole list with an uploaded devices.json (for example one downloaded earlier with
    // "Download current list"). dryRun checks the file and says what would change without touching anything.
    // The current list is saved to the history first, so it can be undone with Restore.
    if (kind === "import-file" && method === "POST") {
      const body = await readJson(req, 2000000);
      const list = parseDeviceFile(String(body.text || ""));
      const errors = deviceListErrors(list.decoders, list.encoders);
      if (errors.length) throw new HttpError(400, errors.join("; "));
      const summary = summarizeDeviceFile(list);
      if (body.dryRun) return reply(res, 200, { ok: true, dryRun: true, ...summary });
      commitDevices(list.decoders, list.encoders, {
        by: user.username,
        reason: "restore the list from an uploaded file",
        spaces: list.spaces,
      });
      return reply(res, 200, {
        ok: true,
        ...summary,
        decoders: config.decoders,
        encoders: config.encoders,
      });
    }

    return reply(res, 404, { error: "Not found" });
  } catch (e) {
    if (e instanceof HttpError) return reply(res, e.status, { error: e.message });
    if (e.message === "Bad JSON") return reply(res, 400, { error: "Bad JSON" });
    if (e.message === "Request too large")
      return reply(res, 400, {
        error:
          "That is too large to send in one go. A pasted list can have up to 500 lines; a file can be up to 2 MB.",
      });
    logEvent(`Devices API error: ${e.stack || e.message}`);
    return reply(res, 500, { error: "Something went wrong saving the device list" });
  }
}
