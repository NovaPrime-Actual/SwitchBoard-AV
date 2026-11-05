// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// BRANDING API for SwitchBoard-AV
// Description: Admin only: reading and saving the name, logo and colours from the Branding tab.
// ===========================================

import fs from "node:fs";
import {
  BRANDING_DIR,
  BRANDING_PATH,
  BRAND_DEFAULTS,
  LOGO_KINDS,
  MAX_LOGO_BYTES,
  accentProblem,
  accentTint,
  branding,
  cleanLabel,
  hasLogoFile,
  logoFilePath,
  removeFileIfPresent,
  removeLogoFiles,
  resetBranding,
  saveBranding,
} from "../branding.js";
import { readJson, reply } from "../http.js";
import { logEvent } from "../log.js";
import { logActivity } from "../store.js";

function brandingAdminView() {
  return {
    appName: branding.appName,
    orgName: branding.orgName,
    accent: branding.accent,
    accentTint: accentTint(branding.accent),
    select: branding.select,
    selectTint: accentTint(branding.select),
    hasLogo: hasLogoFile(),
    logoUrl: hasLogoFile() ? `/branding/logo?v=${branding.logoVersion}` : "/branding/logo",
    defaults: BRAND_DEFAULTS,
  };
}

export async function handleAdminBranding(req, res, user, rest) {
  if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
  if (rest.length === 0 && req.method === "GET") return reply(res, 200, brandingAdminView());
  if (rest[0] === "reset" && req.method === "POST") {
    removeLogoFiles();
    resetBranding();
    removeFileIfPresent(BRANDING_PATH);
    logActivity({
      type: "branding_reset",
      by: user.username,
      detail: "branding set back to the defaults",
    });
    return reply(res, 200, brandingAdminView());
  }
  if (rest.length === 0 && req.method === "POST") {
    let body;
    try {
      body = await readJson(req, 800000);
    } catch (err) {
      return reply(res, 400, {
        error:
          err.message === "Request too large"
            ? "That logo file is too large (the limit is 512 KB)."
            : "Bad request",
      });
    }
    const appName = cleanLabel(body.appName, 40);
    const orgName = cleanLabel(body.orgName, 80);
    if (appName === null)
      return reply(res, 400, {
        error: "The app name must be 40 characters or fewer, with no line breaks.",
      });
    if (appName === "") return reply(res, 400, { error: "The app name cannot be empty." });
    if (orgName === null)
      return reply(res, 400, {
        error: "The organization name must be 80 characters or fewer, with no line breaks.",
      });
    const accent = String(body.accent || "")
      .trim()
      .toLowerCase();
    const problem = accentProblem(accent);
    if (problem) return reply(res, 400, { error: problem });
    // the highlight colour is optional in the request: leave it as it is when not sent
    const select =
      body.select === undefined
        ? branding.select
        : String(body.select || "")
            .trim()
            .toLowerCase();
    const selectProblem = accentProblem(select);
    if (selectProblem) return reply(res, 400, { error: `Highlight colour: ${selectProblem}` });

    let newLogo = null;
    if (body.logo && body.logo.data) {
      const b64 = String(body.logo.data);
      if (!/^[A-Za-z0-9+/=\s]+$/.test(b64))
        return reply(res, 400, { error: "That does not look like an image file." });
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0) return reply(res, 400, { error: "That logo file is empty." });
      if (bytes.length > MAX_LOGO_BYTES)
        return reply(res, 400, { error: "That logo file is too large (the limit is 512 KB)." });
      const kind = LOGO_KINDS.find((k) => k.is(bytes));
      if (!kind)
        return reply(res, 400, {
          error:
            "The logo must be a PNG, JPEG, GIF or WebP picture. (SVG files are not accepted because they can carry scripts; export it as PNG.)",
        });
      newLogo = { kind, bytes };
    }

    const changed = [];
    if (appName !== branding.appName) changed.push("name");
    if (orgName !== branding.orgName) changed.push("organization");
    if (accent !== branding.accent) changed.push(`colour ${accent}`);
    if (select !== branding.select) changed.push(`highlight colour ${select}`);
    try {
      if (newLogo) {
        fs.mkdirSync(BRANDING_DIR, { recursive: true });
        const target = logoFilePath(newLogo.kind.ext);
        fs.writeFileSync(`${target}.tmp`, newLogo.bytes);
        fs.renameSync(`${target}.tmp`, target);
        for (const k of LOGO_KINDS) {
          if (k.ext !== newLogo.kind.ext) removeFileIfPresent(logoFilePath(k.ext));
        }
        branding.logoExt = newLogo.kind.ext;
        branding.logoVersion = Date.now();
        changed.push("logo");
      } else if (body.removeLogo && hasLogoFile()) {
        removeLogoFiles();
        branding.logoExt = null;
        branding.logoVersion = Date.now();
        changed.push("logo removed");
      }
      branding.appName = appName;
      branding.orgName = orgName;
      branding.accent = accent;
      branding.select = select;
      saveBranding();
    } catch (err) {
      logEvent(`Branding save failed: ${err.message}`);
      return reply(res, 500, { error: "Could not save the branding" });
    }
    if (changed.length)
      logActivity({
        type: "branding_update",
        by: user.username,
        detail: `changed ${changed.join(", ")}`,
      });
    return reply(res, 200, brandingAdminView());
  }
  return reply(res, 404, { error: "Not found" });
}
