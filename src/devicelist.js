// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// DEVICE LIST for SwitchBoard-AV
// Description: The device list the app owns (DATA_DIR/devices.store.json), edited in the admin Devices
//   screen. devices.json is only the first-run import; an admin can also replace the list from an uploaded
//   file. Groups point at decoders and sources by IP and at spaces by name, so changing an IP, removing a
//   device or renaming a space is cascaded into the groups here, otherwise people would silently lose (or
//   keep) access. Every change keeps a snapshot of the list as it was before, for restore.
// ===========================================

import {
  DEVICES_STORE_PATH,
  DEVICE_HISTORY_PATH,
  HISTORY_CHOICES,
  HISTORY_DEFAULT,
  INPUT_CHOICES,
  TV_PROTOCOLS,
  readSeedFile,
} from "./config.js";
import { atomicWrite, loadJsonFile } from "./files.js";
import {
  healthCache,
  inputState,
  lastKnown,
  lastReply,
  reachability,
  screenState,
  tvState,
} from "./state.js";
import { logActivity, saveStore, store } from "./store.js";

export let deviceHistory = loadJsonFile(DEVICE_HISTORY_PATH, []);

// The live device list. Every handler reads config.decoders / config.encoders at call time, so replacing
// the arrays (commitDevices) takes effect immediately with no restart.
export let deviceListSource = "saved";

export const config = loadDeviceList();

export class HttpError extends Error {
  constructor(status, message, options) {
    super(message, options);
    this.status = status;
  }
}

export function isStrictIp(ip) {
  return (
    typeof ip === "string" &&
    /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) &&
    ip.split(".").every((n) => Number(n) <= 255)
  );
}

export function cleanDecoder(d) {
  const out = {
    name: String(d.name || "").trim(),
    space: String(d.space || "").trim() || "Unassigned",
    ip: String(d.ip || "").trim(),
  };
  if (d.tvPower) out.tvPower = String(d.tvPower).trim();
  if (d.tvSetId) out.tvSetId = String(d.tvSetId).trim();
  return out;
}

// An encoder lists the inputs staff may choose between in "inputs" (values from inputChoices); no list = no
// input switching.
export function cleanEncoder(e) {
  const out = { name: String(e.name || "").trim(), ip: String(e.ip || "").trim() };
  // "space" makes this a LOCAL source: only offered on screens in that space, and not part of any group's
  // source list. No space = a shared source, as before.
  const space = String(e.space || "").trim();
  if (space) out.space = space;
  if (Array.isArray(e.inputs)) {
    const picked = INPUT_CHOICES.filter((v) => e.inputs.includes(v));
    if (picked.length) out.inputs = picked;
  }
  return out;
}

// Problems with one device on its own (not counting clashes with other devices).
export function deviceErrors(d, kind) {
  const errors = [];
  const label = d.name || d.ip || "(unnamed)";
  if (!d.name) errors.push(`A ${kind} has no name`);
  if (d.name.length > 64) errors.push(`${label}: name is longer than 64 characters`);
  if (!isStrictIp(d.ip)) errors.push(`${label}: "${d.ip}" is not a valid IP address`);
  if (kind === "screen") {
    if (d.space.length > 64) errors.push(`${label}: space name is longer than 64 characters`);
    if (d.tvPower && !TV_PROTOCOLS[d.tvPower])
      errors.push(`${label}: unknown TV power type "${d.tvPower}"`);
    if (d.tvSetId && !/^[0-9a-f]{2}$/i.test(d.tvSetId))
      errors.push(`${label}: TV Set ID must be two characters, like 00 or 01`);
  }
  return errors;
}

export function deviceListErrors(decoders, encoders) {
  const errors = [];
  const owner = new Map(); // ip -> label of the first device using it
  for (const [kind, list] of [
    ["screen", decoders],
    ["source", encoders],
  ]) {
    for (const d of list) {
      errors.push(...deviceErrors(d, kind));
      if (!isStrictIp(d.ip)) continue;
      if (owner.has(d.ip))
        errors.push(`IP ${d.ip} is used by both ${owner.get(d.ip)} and ${d.name || d.ip}`);
      else owner.set(d.ip, d.name || d.ip);
    }
  }
  return errors;
}

// The spaces list is kept in order and always contains every space a screen uses, plus any space an
// admin added on its own (an empty space, ready for screens). It only shrinks when a space is deleted.
export function mergeSpaces(decoders, listed, encoders = []) {
  return [
    ...new Set([
      ...(listed || []).map((s) => String(s).trim()).filter(Boolean),
      ...decoders.map((d) => d.space),
      ...encoders.map((e) => e.space).filter(Boolean),
    ]),
  ];
}

function loadDeviceList() {
  const saved = loadJsonFile(DEVICES_STORE_PATH, null);
  if (saved) {
    const decoders = (saved.decoders || []).map(cleanDecoder);
    const encoders = (saved.encoders || []).map(cleanEncoder);
    return { decoders, encoders, spaces: mergeSpaces(decoders, saved.spaces, encoders) };
  }
  // New server setup: import devices.json once (an empty list if the file is missing or unreadable).
  deviceListSource = "imported";
  const seedConfig = readSeedFile();
  const decoders = (seedConfig.decoders || []).map(cleanDecoder);
  const encoders = (seedConfig.encoders || []).map(cleanEncoder);
  const list = { decoders, encoders, spaces: mergeSpaces(decoders, seedConfig.spaces, encoders) };
  atomicWrite(DEVICES_STORE_PATH, { updatedAt: Date.now(), ...list });
  return list;
}

export function historyKeep() {
  const v = store.settings && store.settings.deviceHistoryKeep;
  return HISTORY_CHOICES.includes(v) ? v : HISTORY_DEFAULT;
}

// Keeps only the newest `keep` snapshots of the device list and saves the result.
export function trimDeviceHistory(keep) {
  if (deviceHistory.length <= keep) return;
  deviceHistory = deviceHistory.slice(-keep);
  atomicWrite(DEVICE_HISTORY_PATH, deviceHistory);
}

function recordDeviceHistory(by, reason) {
  deviceHistory.push({
    at: Date.now(),
    by,
    reason, // what the change was; the snapshot is the list as it stood BEFORE it
    decoders: structuredClone(config.decoders),
    encoders: structuredClone(config.encoders),
    spaces: structuredClone(config.spaces),
  });
  if (deviceHistory.length > historyKeep()) deviceHistory = deviceHistory.slice(-historyKeep());
  atomicWrite(DEVICE_HISTORY_PATH, deviceHistory);
}

// cascade: { decoderIps, encoderIps: Map(old ip -> new ip, or null to drop), spaces: Map(old name -> new name, or null) }
// spaces: the next spaces list (defaults to the current one); every space a screen uses is added to it.
export function commitDevices(decoders, encoders, { by, reason, cascade = {}, spaces }) {
  const errors = deviceListErrors(decoders, encoders);
  const nextSpaces = mergeSpaces(decoders, spaces === undefined ? config.spaces : spaces, encoders);
  for (const s of nextSpaces)
    if (s.length > 64)
      errors.push(`Space name "${s.slice(0, 20)}..." is longer than 64 characters`);
  if (errors.length) throw new HttpError(400, errors.join("; "));

  recordDeviceHistory(by, reason);

  let groupsUpdated = 0;
  const remap = (list, map) => {
    if (!map || !Array.isArray(list)) return { list, changed: false };
    let changed = false;
    const out = [];
    for (const v of list) {
      if (map.has(v)) {
        changed = true;
        const to = map.get(v);
        if (to && !out.includes(to)) out.push(to);
      } else if (!out.includes(v)) out.push(v);
    }
    return { list: out, changed };
  };
  for (const g of Object.values(store.groups)) {
    let changed = false;
    for (const [field, map] of [
      ["decoders", cascade.decoderIps],
      ["excludeDecoders", cascade.decoderIps],
      ["sources", cascade.encoderIps],
      ["spaces", cascade.spaces],
    ]) {
      const r = remap(g[field], map);
      if (r.changed) {
        g[field] = r.list;
        changed = true;
      }
    }
    if (changed) groupsUpdated++;
  }
  atomicWrite(DEVICES_STORE_PATH, {
    updatedAt: Date.now(),
    decoders,
    encoders,
    spaces: nextSpaces,
  }); // on disk first, then live
  if (groupsUpdated) saveStore();
  config.decoders = decoders;
  config.encoders = encoders;
  config.spaces = nextSpaces;

  // forget live state for IPs that are gone
  const live = new Set([...decoders, ...encoders].map((d) => d.ip));
  for (const m of [
    lastKnown,
    reachability,
    tvState,
    lastReply,
    healthCache,
    screenState,
    inputState,
  ])
    for (const ip of [...m.keys()]) if (!live.has(ip)) m.delete(ip);

  logActivity({ type: "admin_device", by, detail: reason });
  return { groupsUpdated };
}
