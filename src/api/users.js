// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// USERS API for SwitchBoard-AV
// Description: Admin only: creating, editing, disabling and deleting users, and temporary passwords.
// ===========================================

import { destroySessionsForUser, findUserByUsername, hashPassword, safeUser } from "../auth.js";
import { readJsonOrRefuse, reply } from "../http.js";
import { activeAdminCount, canManage, managedGroupIds, tidyGroupManagers } from "../scoping.js";
import { logActivity, saveStore, store } from "../store.js";
import { genId, genTempPassword } from "../util.js";

function listUsers(res, user) {
  let list = Object.values(store.users);
  if (user.role === "manager") {
    const mine = new Set(managedGroupIds(user.username));
    list = list.filter((u) => (u.groups || []).some((g) => mine.has(g)));
  }
  return reply(res, 200, list.map(safeUser));
}

async function createUser(req, res, user) {
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const name = String(body.name || "").trim();
  const username = String(body.username || "")
    .trim()
    .toLowerCase();
  if (!name || !username) return reply(res, 400, { error: "Name and username are required" });
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return reply(res, 400, { error: "Username must be 3-32 characters: letters, numbers, . _ -" });
  }
  if (findUserByUsername(username))
    return reply(res, 400, { error: "That username is already in use" });

  let role = "user";
  let groups = Array.isArray(body.groups) ? body.groups.filter((g) => store.groups[g]) : [];

  if (user.role === "admin") {
    if (["user", "manager", "admin"].includes(body.role)) role = body.role;
  } else {
    // Manager: role is always "user", and the new account must land in at least one group they manage.
    const mine = new Set(managedGroupIds(user.username));
    groups = groups.filter((g) => mine.has(g));
    if (groups.length === 0)
      return reply(res, 400, { error: "Assign the new user to at least one of your groups" });
  }

  const tempPassword = genTempPassword();
  const { salt, hash } = await hashPassword(tempPassword);
  const id = genId("u");
  const newUser = {
    id,
    username,
    name,
    role,
    groups,
    passwordHash: hash,
    passwordSalt: salt,
    mustChangePassword: true,
    disabled: false,
    createdAt: Date.now(),
  };
  store.users[id] = newUser;
  saveStore();
  logActivity({ type: "admin_user_create", by: user.username, username, role });
  return reply(res, 200, { user: safeUser(newUser), tempPassword });
}

async function resetPassword(req, res, user, id) {
  const target = store.users[id];
  if (!target) return reply(res, 404, { error: "User not found" });
  if (!canManage(user, target)) return reply(res, 403, { error: "Forbidden" });
  const tempPassword = genTempPassword();
  const { salt, hash } = await hashPassword(tempPassword);
  target.passwordHash = hash;
  target.passwordSalt = salt;
  target.mustChangePassword = true;
  destroySessionsForUser(target.id); // old session would otherwise be stuck on a change-password screen it can't pass
  saveStore();
  logActivity({ type: "admin_password_reset", by: user.username, username: target.username });
  return reply(res, 200, { tempPassword });
}

async function setDisabled(req, res, user, id) {
  const target = store.users[id];
  if (!target) return reply(res, 404, { error: "User not found" });
  if (!canManage(user, target)) return reply(res, 403, { error: "Forbidden" });
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const disabled = !!body.disabled;
  if (disabled && target.role === "admin" && activeAdminCount(target.id) < 1) {
    return reply(res, 400, { error: "Cannot disable the last active admin" });
  }
  target.disabled = disabled;
  if (disabled) destroySessionsForUser(target.id);
  saveStore();
  logActivity({
    type: "admin_user_disable",
    by: user.username,
    username: target.username,
    disabled,
  });
  return reply(res, 200, safeUser(target));
}

async function setUserGroups(req, res, user, id) {
  const target = store.users[id];
  if (!target) return reply(res, 404, { error: "User not found" });
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const requested = Array.isArray(body.groups) ? body.groups.filter((g) => store.groups[g]) : [];

  if (user.role === "admin") {
    target.groups = requested;
  } else if (user.role === "manager") {
    if (target.role !== "user") return reply(res, 403, { error: "Forbidden" });
    const mine = new Set(managedGroupIds(user.username));
    const current = target.groups || [];
    const alreadyMine = current.some((g) => mine.has(g));
    const requestedMine = requested.filter((g) => mine.has(g));
    if (!alreadyMine && requestedMine.length === 0) return reply(res, 403, { error: "Forbidden" });
    // Merge: groups outside this manager's control are left untouched, never treated as "removed".
    const keepOutsideScope = current.filter((g) => !mine.has(g));
    target.groups = [...new Set([...keepOutsideScope, ...requestedMine])];
  } else {
    return reply(res, 403, { error: "Forbidden" });
  }
  saveStore();
  logActivity({
    type: "admin_user_groups",
    by: user.username,
    username: target.username,
    groups: target.groups,
  });
  return reply(res, 200, safeUser(target));
}

async function setUserRole(req, res, user, id) {
  const target = store.users[id];
  if (!target) return reply(res, 404, { error: "User not found" });
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  if (!["user", "manager", "admin"].includes(body.role))
    return reply(res, 400, { error: "Invalid role" });
  if (target.role === "admin" && body.role !== "admin" && activeAdminCount(target.id) < 1) {
    return reply(res, 400, { error: "Cannot demote the last active admin" });
  }
  target.role = body.role;
  // Someone who stops being a Manager stops managing groups too, so the dropdown never lists them and the
  // entry can't quietly confer rights again if they are given the role back later.
  const groupsUpdated = tidyGroupManagers();
  saveStore();
  logActivity({
    type: "admin_user_role",
    by: user.username,
    username: target.username,
    role: body.role,
    ...(groupsUpdated
      ? {
          detail: `removed from the managers of ${groupsUpdated} group${groupsUpdated === 1 ? "" : "s"}`,
        }
      : {}),
  });
  return reply(res, 200, { ...safeUser(target), groupsUpdated });
}

// Display name only — usernames never change, so a group's `managers` list (stored by username)
// can never silently re-point at a different account.
async function renameUser(req, res, user, id) {
  const target = store.users[id];
  if (!target) return reply(res, 404, { error: "User not found" });
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const name = String(body.name || "").trim();
  if (!name) return reply(res, 400, { error: "Name required" });
  target.name = name;
  saveStore();
  logActivity({ type: "admin_user_rename", by: user.username, username: target.username, name });
  return reply(res, 200, safeUser(target));
}

// Username change (admin edit form). Group `managers` lists store usernames, so they are re-pointed here.
async function changeUsername(req, res, user, id) {
  const target = store.users[id];
  if (!target) return reply(res, 404, { error: "User not found" });
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const username = String(body.username || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return reply(res, 400, { error: "Username must be 3-32 characters: letters, numbers, . _ -" });
  }
  const existing = findUserByUsername(username);
  if (existing && existing.id !== target.id)
    return reply(res, 400, { error: "That username is already in use" });
  const oldUsername = target.username;
  if (oldUsername === username) return reply(res, 200, safeUser(target));
  target.username = username;
  for (const g of Object.values(store.groups)) {
    g.managers = (g.managers || []).map((m) => (m === oldUsername ? username : m));
  }
  saveStore();
  logActivity({
    type: "admin_user_username",
    by: user.username,
    username: oldUsername,
    newUsername: username,
  });
  return reply(res, 200, safeUser(target));
}

async function deleteUser(req, res, user, id) {
  const target = store.users[id];
  if (!target) return reply(res, 404, { error: "User not found" });
  if (target.id === user.id)
    return reply(res, 400, { error: "You cannot delete your own account" });
  if (target.role === "admin" && activeAdminCount(target.id) < 1) {
    return reply(res, 400, { error: "Cannot delete the last active admin" });
  }
  delete store.users[id];
  // A reused username must never inherit a deleted manager's group-manager rights.
  for (const g of Object.values(store.groups))
    g.managers = (g.managers || []).filter((m) => m !== target.username);
  destroySessionsForUser(id);
  saveStore();
  logActivity({ type: "admin_user_delete", by: user.username, username: target.username });
  return reply(res, 200, { ok: true });
}

export async function handleAdminUsers(req, res, user, rest) {
  if (user.role !== "admin" && user.role !== "manager")
    return reply(res, 403, { error: "Forbidden" });
  if (rest.length === 0 && req.method === "GET") return listUsers(res, user);
  if (rest.length === 0 && req.method === "POST") return createUser(req, res, user);
  if (rest.length === 2 && rest[1] === "reset-password" && req.method === "POST")
    return resetPassword(req, res, user, rest[0]);
  if (rest.length === 2 && rest[1] === "disable" && req.method === "POST")
    return setDisabled(req, res, user, rest[0]);
  if (rest.length === 2 && rest[1] === "groups" && req.method === "POST")
    return setUserGroups(req, res, user, rest[0]);
  if (rest.length === 2 && rest[1] === "role" && req.method === "POST") {
    if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
    return setUserRole(req, res, user, rest[0]);
  }
  if (rest.length === 2 && rest[1] === "rename" && req.method === "POST") {
    if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
    return renameUser(req, res, user, rest[0]);
  }
  if (rest.length === 2 && rest[1] === "username" && req.method === "POST") {
    if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
    return changeUsername(req, res, user, rest[0]);
  }
  if (rest.length === 1 && req.method === "DELETE") {
    if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
    return deleteUser(req, res, user, rest[0]);
  }
  return reply(res, 404, { error: "Not found" });
}
