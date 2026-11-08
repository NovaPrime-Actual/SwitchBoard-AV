// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// SCOPING for SwitchBoard-AV
// Description: Who may see and switch which decoders and sources.
// ===========================================

import { safeUser } from "./auth.js";
import { TV_PROTOCOLS } from "./config.js";
import { config } from "./devicelist.js";
import { store } from "./store.js";

function userGroupObjects(user) {
  return (user.groups || []).map((id) => store.groups[id]).filter(Boolean);
}

// The signed-in person's own record for the page: the usual fields plus the NAMES of their groups
// (a plain user cannot read the group list, but may know which groups they belong to).
export function selfView(user) {
  return { ...safeUser(user), groupNames: userGroupObjects(user).map((g) => g.name) };
}

// A group's managers are the usernames of people who hold the Manager role. Anything else (a deleted user,
// someone who has been demoted, a mistyped name) is dropped.
export function validManagers(list) {
  const managers = new Set(
    Object.values(store.users)
      .filter((u) => u.role === "manager")
      .map((u) => u.username),
  );
  return [
    ...new Set(
      (Array.isArray(list) ? list : []).filter((m) => typeof m === "string" && managers.has(m)),
    ),
  ];
}

// Removes stale managers from every group. Returns how many groups changed (the caller saves the store).
export function tidyGroupManagers() {
  let changed = 0;
  for (const g of Object.values(store.groups)) {
    const before = g.managers || [];
    const after = validManagers(before);
    if (after.length !== before.length) {
      g.managers = after;
      changed++;
    }
  }
  return changed;
}

export function managedGroupIds(username) {
  return Object.values(store.groups)
    .filter((g) => (g.managers || []).includes(username))
    .map((g) => g.id);
}

// A single group's own decoder set: spaces ∪ explicit decoders, minus that group's own excludeDecoders.
export function groupDecoderSet(g) {
  const set = new Set();
  for (const d of config.decoders) if ((g.spaces || []).includes(d.space)) set.add(d.ip);
  for (const ip of g.decoders || []) set.add(ip);
  for (const ip of g.excludeDecoders || []) set.delete(ip);
  return set;
}

export function visibleDecoderSet(user) {
  if (user.role === "admin") return new Set(config.decoders.map((d) => d.ip));
  const set = new Set();
  for (const g of userGroupObjects(user)) for (const ip of groupDecoderSet(g)) set.add(ip);
  return set;
}

// Decoders whose TV this user may power on/off: the decoder must opt in (devices.json "tvPower")
// and, unless the user is an admin, sit in a group ticked "can control TV power".
// Sources whose input this user may change: the encoder must offer input switching (devices "inputs") and,
// unless the user is an admin, be one of the sources of a group ticked "can change source inputs".
export function inputControlEncoderSet(user) {
  const switchable = config.encoders.filter((e) => Array.isArray(e.inputs) && e.inputs.length > 0);
  if (user.role === "admin") return new Set(switchable.map((e) => e.ip));
  let all = false;
  const allowed = new Set();
  const controlled = new Set(); // screens of groups ticked "can change source inputs"
  for (const g of userGroupObjects(user)) {
    if (!g.inputControl) continue;
    for (const ip of groupDecoderSet(g)) controlled.add(ip);
    if (g.sources === "all") all = true;
    else for (const ip of g.sources || []) allowed.add(ip);
  }
  const localSpaces = spacesOfDecoders(controlled);
  return new Set(
    switchable
      .filter((e) => (e.space ? localSpaces.has(e.space) : all || allowed.has(e.ip)))
      .map((e) => e.ip),
  );
}

// Screens this user may switch together with others ("select several"): every screen for an admin, otherwise
// the screens of any of their groups ticked "can switch several screens at once". A request for more than one
// screen needs every one of them in this set; a single screen never does.
export function multiSwitchDecoderSet(user) {
  if (user.role === "admin") return new Set(config.decoders.map((d) => d.ip));
  const allowed = new Set();
  for (const g of userGroupObjects(user)) {
    if (!g.multiSwitch) continue;
    for (const ip of groupDecoderSet(g)) allowed.add(ip);
  }
  return allowed;
}

// Screens this user may blank or put a message on: every screen for an admin, otherwise the screens
// of any of their groups ticked "can blank screens and show messages".
export function screenControlDecoderSet(user) {
  if (user.role === "admin") return new Set(config.decoders.map((d) => d.ip));
  const allowed = new Set();
  for (const g of userGroupObjects(user)) {
    if (!g.screenControl) continue;
    for (const ip of groupDecoderSet(g)) allowed.add(ip);
  }
  return allowed;
}

export function tvPowerDecoderSet(user) {
  const supported = config.decoders.filter((d) => TV_PROTOCOLS[d.tvPower]);
  if (user.role === "admin") return new Set(supported.map((d) => d.ip));
  const allowed = new Set();
  for (const g of userGroupObjects(user)) {
    if (!g.tvPower) continue;
    for (const ip of groupDecoderSet(g)) allowed.add(ip);
  }
  return new Set(supported.filter((d) => allowed.has(d.ip)).map((d) => d.ip));
}

// The spaces of the given screens (a set of IPs), found in one pass over the screen list.
function spacesOfDecoders(ips) {
  return new Set(config.decoders.filter((d) => ips.has(d.ip)).map((d) => d.space));
}

// A LOCAL source (encoder with a "space") may only be shown on, and switched onto, screens in that space.
export function sourceFitsScreen(encoder, decoder) {
  return !encoder.space || encoder.space === decoder.space;
}

// Shared sources come from the groups' source lists ("all sources" never includes local ones). Local sources
// are separate: a person gets one when they can see at least one screen in its space.
export function visibleSourceSet(user) {
  if (user.role === "admin") return new Set(config.encoders.map((e) => e.ip));
  let sawAll = false;
  const set = new Set();
  for (const g of userGroupObjects(user)) {
    if (g.sources === "all") {
      sawAll = true;
      continue;
    }
    for (const ip of g.sources || []) set.add(ip);
  }
  const mySpaces = spacesOfDecoders(visibleDecoderSet(user));
  return new Set(
    config.encoders
      .filter((e) => (e.space ? mySpaces.has(e.space) : sawAll || set.has(e.ip)))
      .map((e) => e.ip),
  );
}

export function activeAdminCount(excludeId) {
  return Object.values(store.users).filter(
    (u) => u.role === "admin" && !u.disabled && u.id !== excludeId,
  ).length;
}

// Whether `actor` (admin/manager) may act on `target` via the admin-area user endpoints.
export function canManage(actor, target) {
  if (actor.id === target.id) return false; // self-service goes through /api/change-password
  if (actor.role === "admin") return true;
  if (actor.role === "manager") {
    if (target.role !== "user") return false; // managers never touch admin or manager accounts
    const mine = new Set(managedGroupIds(actor.username));
    return (target.groups || []).some((g) => mine.has(g));
  }
  return false;
}
