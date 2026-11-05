// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// AUTH for SwitchBoard-AV
// Description: Password hashing, sessions and the sign-in throttle.
// ===========================================

import crypto from "node:crypto";
import { promisify } from "node:util";
import { THROTTLE_FREE_ATTEMPTS, THROTTLE_MAX_LOCK_MS } from "./config.js";
import { store } from "./store.js";
import { positiveNumber } from "./util.js";

const scrypt = promisify(crypto.scrypt);

// decoder ip -> array of functions fed every raw reply (Query tester)
export const sessions = new Map();

const SESSION_IDLE_MS = positiveNumber(process.env.SESSION_IDLE_MINUTES, 120) * 60 * 1000;

const SESSION_MAX_MS = positiveNumber(process.env.SESSION_MAX_HOURS, 12) * 60 * 60 * 1000;

const ipFailures = new Map();

// address -> { count, since }: failed sign-ins from one address
const IP_FAIL_WINDOW_MS = 10 * 60 * 1000;

const IP_FAIL_MAX = 30;

// failed sign-ins from one address (any usernames) per window before it is paused
const loginAttempts = new Map();

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)).toString("hex");
  return { salt, hash };
}

export async function verifyPassword(user, password) {
  const candidate = (await scrypt(String(password || ""), user.passwordSalt, 64)).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(user.passwordHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function findUserByUsername(username) {
  const uname = String(username || "").toLowerCase();
  return Object.values(store.users).find((u) => u.username.toLowerCase() === uname) || null;
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  sessions.set(token, { userId, createdAt: now, lastActive: now });
  return token;
}

export function destroySessionsForUser(userId, exceptToken) {
  for (const [token, sess] of sessions)
    if (sess.userId === userId && token !== exceptToken) sessions.delete(token);
}

// A session ends after SESSION_IDLE_MINUTES without the person doing anything, and in any case after
// SESSION_MAX_HOURS since they signed in.
function sessionExpired(sess, now) {
  return now - sess.lastActive > SESSION_IDLE_MS || now - sess.createdAt > SESSION_MAX_MS;
}

export function pruneSessions() {
  const now = Date.now();
  for (const [token, sess] of sessions) if (sessionExpired(sess, now)) sessions.delete(token);
  for (const [ip, e] of ipFailures) if (now - e.since > IP_FAIL_WINDOW_MS) ipFailures.delete(ip);
}

// Failed sign-ins from one address, across every username, so trying many accounts is slowed down too.
export function ipBlocked(ip) {
  const e = ipFailures.get(ip);
  if (!e) return false;
  if (Date.now() - e.since > IP_FAIL_WINDOW_MS) {
    ipFailures.delete(ip);
    return false;
  }
  return e.count >= IP_FAIL_MAX;
}

export function recordIpFailure(ip) {
  const e = ipFailures.get(ip);
  if (!e || Date.now() - e.since > IP_FAIL_WINDOW_MS)
    ipFailures.set(ip, { count: 1, since: Date.now() });
  else e.count += 1;
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Re-reads the user (role/groups/disabled) from the store on every call — never cached in the session.
// A request counts as the person being active (keeping the session alive) unless the page marked it as a
// background refresh with "X-Background: 1". Sets req.sessionExpired when a session that existed has ended.
export function currentAuth(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess) return null;
  const now = Date.now();
  if (sessionExpired(sess, now)) {
    sessions.delete(token);
    req.sessionExpired = true;
    return null;
  }
  const user = store.users[sess.userId];
  if (!user || user.disabled) {
    sessions.delete(token);
    return null;
  }
  if (req.headers["x-background"] !== "1") sess.lastActive = now;
  return { user, token };
}

function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-proto"] === "https") return true;
  return false;
}

export function setSessionCookie(req, res, token) {
  const secure = isHttps(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`);
}

export function clearSessionCookie(req, res) {
  const secure = isHttps(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

export function throttleKey(username, ip) {
  return `${String(username || "").toLowerCase()}|${ip}`;
}

export function isLocked(key) {
  const entry = loginAttempts.get(key);
  return !!(entry && entry.lockUntil && entry.lockUntil > Date.now());
}

export function recordLoginFailure(key) {
  const entry = loginAttempts.get(key) || { fails: 0, lockUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= THROTTLE_FREE_ATTEMPTS) {
    const backoffMs = Math.min(
      THROTTLE_MAX_LOCK_MS,
      1000 * 2 ** (entry.fails - THROTTLE_FREE_ATTEMPTS),
    );
    entry.lockUntil = Date.now() + backoffMs;
  }
  loginAttempts.set(key, entry);
}

export function recordLoginSuccess(key) {
  loginAttempts.delete(key);
}

export function safeUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    groups: u.groups || [],
    disabled: !!u.disabled,
    mustChangePassword: !!u.mustChangePassword,
    createdAt: u.createdAt,
  };
}

export function safeGroupFull(g) {
  return {
    id: g.id,
    name: g.name,
    spaces: g.spaces || [],
    decoders: g.decoders || [],
    excludeDecoders: g.excludeDecoders || [],
    sources: g.sources === "all" ? "all" : g.sources || [],
    managers: g.managers || [],
    tvPower: g.tvPower === true, // members may power on/off the TVs of screens set up for it
    screenControl: g.screenControl === true, // members may blank screens and show a message on them
    inputControl: g.inputControl === true, // members may change which input an encoder in their sources uses
    multiSwitch: g.multiSwitch === true, // members may pick several screens and switch them together
  };
}
