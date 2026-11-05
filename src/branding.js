// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// BRANDING for SwitchBoard-AV
// Description: Name, logo and accent colour set by an admin in the Branding tab, the public
//   /branding.css and /branding/logo, and the placeholders filled into index.html.
// ===========================================

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, STATIC_ROOT } from "./config.js";
import { atomicWrite, loadJsonFile } from "./files.js";
import { logEvent } from "./log.js";

export const BRANDING_PATH = path.join(DATA_DIR, "branding.json");

export const BRANDING_DIR = path.join(DATA_DIR, "branding");

// accent = header and buttons; select = the highlight on selected things (the open space, the chosen source, picked tiles)
export const BRAND_DEFAULTS = {
  appName: "SwitchBoard-AV",
  orgName: "",
  accent: "#59606b",
  select: "#a6171d",
};

export const MAX_LOGO_BYTES = 512 * 1024;

// Logos are checked by their first bytes, not their file name. SVG is not accepted: it can carry script.
export const LOGO_KINDS = [
  {
    ext: "png",
    type: "image/png",
    is: (b) =>
      b.length > 8 &&
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: "jpg",
    type: "image/jpeg",
    is: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "gif",
    type: "image/gif",
    is: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")),
  },
  {
    ext: "webp",
    type: "image/webp",
    is: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

const PAGE_BACKGROUND = [0x20, 0x1e, 0x1c];

// matches --surface-0 in tokens.css
const PANEL_BACKGROUND = [0x30, 0x2e, 0x2c];

// --surface-1
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return (
    "#" +
    rgb
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

function relativeLuminance(rgb) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The accent is the header / button colour with white text on it, on a dark page. Returns a plain-English
// problem, or null if the colour works.
export function accentProblem(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(hex)))
    return "The colour must look like #59606b (a # and six letters or digits).";
  const rgb = hexToRgb(hex);
  if (contrastRatio(rgb, [255, 255, 255]) < 4.5)
    return "That colour is too light: white text on it would be hard to read. Pick a darker one.";
  if (contrastRatio(rgb, PAGE_BACKGROUND) < 1.4)
    return "That colour is too dark: buttons would disappear into the page. Pick a lighter one.";
  return null;
}

// A lighter shade of the accent for text and focus rings on the dark page (the accent itself is too dark there).
export function accentTint(hex) {
  const rgb = hexToRgb(hex);
  for (let t = 0.3; t <= 1.0001; t += 0.05) {
    const c = rgb.map((v) => v + (255 - v) * t);
    if (contrastRatio(c, PANEL_BACKGROUND) >= 4.0) return rgbToHex(c);
  }
  return "#ffffff";
}

function hasControlCharacter(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function cleanLabel(value, max) {
  const s = String(value ?? "").trim();
  if (s.length > max) return null;
  if (hasControlCharacter(s)) return null;
  return s;
}

function loadBranding() {
  const raw = loadJsonFile(BRANDING_PATH, {});
  const appName = cleanLabel(raw.appName, 40) || BRAND_DEFAULTS.appName;
  const orgName = cleanLabel(raw.orgName, 80) || "";
  const accent =
    typeof raw.accent === "string" && accentProblem(raw.accent) === null
      ? raw.accent.toLowerCase()
      : BRAND_DEFAULTS.accent;
  const select =
    typeof raw.select === "string" && accentProblem(raw.select) === null
      ? raw.select.toLowerCase()
      : BRAND_DEFAULTS.select;
  const logoExt = LOGO_KINDS.some((k) => k.ext === raw.logoExt) ? raw.logoExt : null;
  return { appName, orgName, accent, select, logoExt, logoVersion: Number(raw.logoVersion) || 0 };
}

export const branding = loadBranding();

// Back to the built-in name and colours, in place so every module that imported `branding` sees it.
export function resetBranding() {
  for (const key of Object.keys(branding)) delete branding[key];
  Object.assign(branding, BRAND_DEFAULTS, { logoExt: null, logoVersion: 0 });
}

export const logoFilePath = (ext) => path.join(BRANDING_DIR, `logo.${ext}`);

export function hasLogoFile() {
  return Boolean(branding.logoExt) && fs.existsSync(logoFilePath(branding.logoExt));
}

// A file that is already gone is the goal, so only other failures are worth a line in the log.
export function removeFileIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== "ENOENT") logEvent(`WARNING: could not remove ${file}: ${err.message}`);
  }
}

export function removeLogoFiles() {
  for (const k of LOGO_KINDS) removeFileIfPresent(logoFilePath(k.ext));
}

export function saveBranding() {
  atomicWrite(BRANDING_PATH, branding);
}

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

export function brandingCss() {
  return `:root {\n  --accent: ${branding.accent};\n  --accent-tint: ${accentTint(branding.accent)};\n  --select: ${branding.select};\n  --select-tint: ${accentTint(branding.select)};\n}\n`;
}

// Fills the placeholders in index.html. Everything inserted is HTML-escaped.
export function renderIndexHtml(html) {
  const logoUrl = hasLogoFile() ? `/branding/logo?v=${branding.logoVersion}` : "/branding/logo";
  return html
    .replace(/<!--(?! SPDX)[\s\S]*?-->\s*/g, "") // author notes stay in the source, not in what visitors download
    .replace(/\{\{APP_NAME\}\}/g, escapeHtml(branding.appName))
    .replace(/\{\{ORG_NAME\}\}/g, escapeHtml(branding.orgName))
    .replace(/\{\{LOGO_ALT\}\}/g, escapeHtml(branding.orgName || branding.appName))
    .replace(/\{\{LOGO_URL\}\}/g, escapeHtml(logoUrl));
}

export function serveLogo(res) {
  // Even though only image types are accepted, send it as an image that cannot run anything.
  const safe = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cache-Control": "no-cache",
  };
  if (hasLogoFile()) {
    const kind = LOGO_KINDS.find((k) => k.ext === branding.logoExt);
    return fs.readFile(logoFilePath(branding.logoExt), (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": kind.type, ...safe });
      res.end(data);
    });
  }
  fs.readFile(path.join(STATIC_ROOT, "logo-default.png"), (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "image/png", ...safe });
    res.end(data);
  });
}
