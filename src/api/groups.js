// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// GROUPS API for SwitchBoard-AV
// Description: Admin only: creating, editing and deleting groups and what each can see.
// ===========================================

import { safeGroupFull } from "../auth.js";
import { readJsonOrRefuse, reply } from "../http.js";
import { validManagers } from "../scoping.js";
import { logActivity, saveStore, store } from "../store.js";
import { genId, isValidIp } from "../util.js";

async function createGroup(req, res, user) {
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const name = String(body.name || "").trim();
  if (!name) return reply(res, 400, { error: "Name required" });
  const id = genId("g");
  const group = {
    id,
    name,
    spaces: Array.isArray(body.spaces) ? body.spaces.filter((s) => typeof s === "string") : [],
    decoders: Array.isArray(body.decoders) ? body.decoders.filter(isValidIp) : [],
    excludeDecoders: Array.isArray(body.excludeDecoders)
      ? body.excludeDecoders.filter(isValidIp)
      : [],
    sources:
      body.sources === "all"
        ? "all"
        : Array.isArray(body.sources)
          ? body.sources.filter(isValidIp)
          : [],
    managers: validManagers(body.managers),
    tvPower: body.tvPower === true,
    screenControl: body.screenControl === true,
    inputControl: body.inputControl === true,
    multiSwitch: body.multiSwitch === true,
  };
  store.groups[id] = group;
  saveStore();
  logActivity({ type: "admin_group_create", by: user.username, group: name });
  return reply(res, 200, safeGroupFull(group));
}

async function updateGroup(req, res, user, id) {
  const group = store.groups[id];
  if (!group) return reply(res, 404, { error: "Group not found" });
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  if (typeof body.name === "string" && body.name.trim()) group.name = body.name.trim();
  if (Array.isArray(body.spaces)) group.spaces = body.spaces.filter((s) => typeof s === "string");
  if (Array.isArray(body.decoders)) group.decoders = body.decoders.filter(isValidIp);
  if (Array.isArray(body.excludeDecoders))
    group.excludeDecoders = body.excludeDecoders.filter(isValidIp);
  if (body.sources === "all") group.sources = "all";
  else if (Array.isArray(body.sources)) group.sources = body.sources.filter(isValidIp);
  if (Array.isArray(body.managers)) group.managers = validManagers(body.managers);
  if (typeof body.tvPower === "boolean") group.tvPower = body.tvPower;
  if (typeof body.screenControl === "boolean") group.screenControl = body.screenControl;
  if (typeof body.inputControl === "boolean") group.inputControl = body.inputControl;
  if (typeof body.multiSwitch === "boolean") group.multiSwitch = body.multiSwitch;
  saveStore();
  logActivity({ type: "admin_group_update", by: user.username, group: group.name });
  return reply(res, 200, safeGroupFull(group));
}

function deleteGroup(req, res, user, id) {
  const group = store.groups[id];
  if (!group) return reply(res, 404, { error: "Group not found" });
  delete store.groups[id];
  for (const u of Object.values(store.users))
    u.groups = (u.groups || []).filter((gid) => gid !== id);
  saveStore();
  logActivity({ type: "admin_group_delete", by: user.username, group: group.name });
  return reply(res, 200, { ok: true });
}

export async function handleAdminGroups(req, res, user, rest) {
  if (rest.length === 0 && req.method === "GET") {
    if (user.role === "admin")
      return reply(res, 200, Object.values(store.groups).map(safeGroupFull));
    if (user.role === "manager") {
      // Managers see only groups they manage, and only enough to pick them for assignment —
      // not the scope itself ("cannot edit what a group covers").
      const mine = Object.values(store.groups).filter((g) =>
        (g.managers || []).includes(user.username),
      );
      return reply(
        res,
        200,
        mine.map((g) => ({ id: g.id, name: g.name })),
      );
    }
    return reply(res, 403, { error: "Forbidden" });
  }
  if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
  if (rest.length === 0 && req.method === "POST") return createGroup(req, res, user);
  if (rest.length === 1 && req.method === "PATCH") return updateGroup(req, res, user, rest[0]);
  if (rest.length === 1 && req.method === "DELETE") return deleteGroup(req, res, user, rest[0]);
  return reply(res, 404, { error: "Not found" });
}
