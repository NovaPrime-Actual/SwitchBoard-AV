// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// UTIL for SwitchBoard-AV
// Description: Small helpers with no state of their own.
// ===========================================

import crypto from "node:crypto";

// token -> { userId, createdAt, lastActive }
// Session lifetime: minutes of doing nothing, and hours since sign-in (decimals allowed). Background refreshes
// from an open page do not count as activity, so a page left open on a shared computer still signs out.
export function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// "username|ip" -> { fails, lockUntil }
export const isValidIp = (ip) => typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs fn over items with at most `limit` running at once; results keep the order of items.
export async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

export function genTempPassword() {
  return crypto.randomBytes(9).toString("base64url");
}
