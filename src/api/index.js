// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// API DISPATCH for SwitchBoard-AV
// Description: Sends each /api/ request to its handler, after checking sign-in and role.
// ===========================================

import { clearSessionCookie, currentAuth, sessions } from "../auth.js";
import { branding } from "../branding.js";
import { APP_LICENSE, APP_SOURCE_URL, APP_VERSION } from "../config.js";
import { reply, snapshot } from "../http.js";
import { selfView } from "../scoping.js";
import { logActivity } from "../store.js";
import { handleAdminActivity, handleAdminHealth, handleAdminSpaces } from "./activity.js";
import { handleChangePassword, handleLogin } from "./auth.js";
import { handleAdminBackup } from "./backup.js";
import { handleAdminBranding } from "./branding.js";
import { handleAdminDevices } from "./devices.js";
import { handleAdminGroups } from "./groups.js";
import {
  handleRefresh,
  handleRoute,
  handleScreen,
  handleSourceInput,
  handleTestQuery,
  handleTvPower,
} from "./routing.js";
import { handleAdminTls } from "./security.js";
import { handleAdminUsers } from "./users.js";

async function handleAdmin(req, res, user, pathname) {
  const seg = pathname.split("/").filter(Boolean); // ["api","admin",...]
  const rest = seg.slice(2);
  if (rest[0] === "users") return handleAdminUsers(req, res, user, rest.slice(1));
  if (rest[0] === "groups") return handleAdminGroups(req, res, user, rest.slice(1));
  if (rest[0] === "activity") return handleAdminActivity(req, res, user);
  if (rest[0] === "spaces") return handleAdminSpaces(req, res, user);
  if (rest[0] === "devices") return handleAdminDevices(req, res, user, rest.slice(1));
  if (rest[0] === "health") return handleAdminHealth(req, res, user, rest.slice(1));
  if (rest[0] === "tls") return handleAdminTls(req, res, user, rest.slice(1));
  if (rest[0] === "branding") return handleAdminBranding(req, res, user, rest.slice(1));
  if (rest[0] === "backup") return handleAdminBackup(req, res, user);
  return reply(res, 404, { error: "Not found" });
}

export async function handleApi(req, res) {
  const u = new URL(req.url, "http://localhost");
  const pathname = u.pathname;

  if (req.method === "POST" && pathname === "/api/login") return handleLogin(req, res);

  const auth = currentAuth(req);
  if (!auth)
    return reply(res, 401, {
      error: req.sessionExpired ? "Your session has ended. Please sign in again." : "Not signed in",
      signedOut: true,
    });
  const { user, token } = auth;

  if (req.method === "POST" && pathname === "/api/logout") {
    sessions.delete(token);
    clearSessionCookie(req, res);
    logActivity({ type: "logout", username: user.username });
    return reply(res, 200, { ok: true });
  }
  if (req.method === "GET" && pathname === "/api/me") return reply(res, 200, selfView(user));
  if (req.method === "POST" && pathname === "/api/change-password")
    return handleChangePassword(req, res, user);

  // Forced password change blocks everything else until it's done.
  if (user.mustChangePassword) return reply(res, 403, { error: "mustChangePassword" });

  if (req.method === "GET" && pathname === "/api/about") {
    return reply(res, 200, {
      appName: branding.appName,
      version: APP_VERSION,
      license: APP_LICENSE.name,
      licenseId: APP_LICENSE.id,
      copyright: APP_LICENSE.copyright,
      sourceUrl: APP_SOURCE_URL,
    });
  }
  if (req.method === "GET" && pathname === "/api/devices") return reply(res, 200, snapshot(user));
  if (req.method === "POST" && pathname === "/api/refresh") return handleRefresh(req, res, user);
  if (req.method === "POST" && pathname === "/api/route") return handleRoute(req, res, user);
  if (req.method === "POST" && pathname === "/api/tv-power") return handleTvPower(req, res, user);
  if (req.method === "POST" && pathname === "/api/screen") return handleScreen(req, res, user);
  if (req.method === "POST" && pathname === "/api/source-input")
    return handleSourceInput(req, res, user);
  if (req.method === "POST" && pathname === "/api/test-query") {
    if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
    return handleTestQuery(req, res, user);
  }
  if (pathname.startsWith("/api/admin/")) return handleAdmin(req, res, user, pathname);

  reply(res, 404, { error: "Not found" });
}
