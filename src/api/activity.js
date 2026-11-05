// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// ACTIVITY API for SwitchBoard-AV
// Description: Admin only: the activity log, and the spaces list the group editor uses.
// ===========================================

import { TV_PROTOCOLS } from "../config.js";
import { healthReport, healthScope, runHealthCheck } from "../decoders.js";
import { config } from "../devicelist.js";
import { reply } from "../http.js";
import { activity } from "../store.js";

export function handleAdminActivity(req, res, user) {
  if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
  if (req.method !== "GET") return reply(res, 404, { error: "Not found" });
  return reply(res, 200, activity.slice().reverse());
}

// GET /api/admin/health  -> what we know now (no network traffic)
// POST /api/admin/health/check -> ask the screens and sources in scope for their model, then return the report
// Admins see everything; a Manager sees (and can ask about) only the screens and sources of the groups they manage.
export async function handleAdminHealth(req, res, user, rest) {
  if (user.role !== "admin" && user.role !== "manager")
    return reply(res, 403, { error: "Admins and managers only" });
  const scope = healthScope(user);
  if (rest.length === 0 && req.method === "GET") return reply(res, 200, healthReport(scope));
  if (rest[0] === "check" && req.method === "POST") {
    await runHealthCheck(scope);
    return reply(res, 200, healthReport(scope));
  }
  return reply(res, 404, { error: "Not found" });
}

export function handleAdminSpaces(req, res, user) {
  if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
  if (req.method !== "GET") return reply(res, 404, { error: "Not found" });
  return reply(
    res,
    200,
    config.spaces.map((name) => ({
      name,
      decoders: config.decoders
        .filter((d) => (d.space || "Unassigned") === name)
        .map((d) => ({ ip: d.ip, name: d.name, tvPower: !!TV_PROTOCOLS[d.tvPower] })),
    })),
  );
}
