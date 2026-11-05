// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// WEB SERVER for SwitchBoard-AV
// Description: The HTTP(S) server and its request handler: security headers, cross-site refusal, and
//   routing a request to the API, the branding routes or the static files.
// ===========================================

import http from "node:http";
import https from "node:https";
import { handleApi } from "./api/index.js";
import { brandingCss, serveLogo } from "./branding.js";
import { reply } from "./http.js";
import { logEvent } from "./log.js";
import { serveStatic } from "./static.js";
import { WEB_PORT } from "./config.js";
import { tlsRuntime } from "./tls-runtime.js";

// HTTPS is on by default (see tls.js). Off only with TLS=off, or TRUST_PROXY=1 when a proxy does the TLS.
// Certificate: server settings (TLS_CERT/TLS_KEY/TLS_PFX) -> one uploaded in the admin Security tab ->
// a self-signed one the app makes itself. Anything unusable falls back to the next; never to plain HTTP.
export const IS_HSTS_ENABLED = /^(1|on|true)$/i.test(String(process.env.HSTS || ""));

// Headers sent with every response. The page only loads its own script and stylesheet and talks only to this
// server, cannot be shown inside another site's frame, and browsers are told not to guess file types or leak
// the address in the Referer header.
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// A browser sends Origin (and Sec-Fetch-Site) with a request that changes something. If it says the request
// came from another site, refuse it, even though the sign-in cookie is already SameSite=Strict. Tools that send
// neither header (curl, scripts) are not browsers and are let through; they still need a valid session.
function crossSiteRequest(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (String(req.headers["sec-fetch-site"] || "") === "cross-site") return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return true; // includes the literal "null" origin
  }
  const mine = [req.headers.host];
  if (process.env.TRUST_PROXY === "1") mine.push(req.headers["x-forwarded-host"]);
  return !mine.some((h) => h && String(h).toLowerCase() === host);
}

const requestHandler = async (req, res) => {
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    // Only meaningful once the browser has accepted the certificate; see README before turning on with a self-signed one.
    if (IS_HSTS_ENABLED && tlsRuntime.current)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const u = new URL(req.url, "http://localhost");
    // answers from the API are never kept by the browser; files of the page are re-checked each time so an update shows at once
    res.setHeader("Cache-Control", u.pathname.startsWith("/api/") ? "no-store" : "no-cache");
    if (u.pathname.startsWith("/api/") && crossSiteRequest(req))
      return reply(res, 403, { error: "That request came from another website and was refused." });
    if (u.pathname.startsWith("/api/")) return await handleApi(req, res);
    // branding is public: the sign-in page needs it before anyone is signed in
    if (u.pathname === "/branding.css") {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return res.end(brandingCss());
    }
    if (u.pathname === "/branding/logo") return serveLogo(res);
    return serveStatic(req, res, u.pathname);
  } catch (err) {
    logEvent(`Request error: ${err.message}`);
    // details stay in the server's log, not in what the browser is told
    if (!res.headersSent) reply(res, 500, { error: "Something went wrong on the server." });
  }
};

export const server = tlsRuntime.current
  ? https.createServer(tlsRuntime.current.options, requestHandler)
  : http.createServer(requestHandler);

tlsRuntime.server = server;

// Someone typed http:// at the HTTPS port. The TLS layer has already consumed their request, so the path they
// typed is gone: send them to the front page of the https:// address they reached. The address comes from the
// connection itself, never from anything the visitor sent.
function answerPlainHttp(err, tlsSocket) {
  if (err.code !== "ERR_SSL_HTTP_REQUEST") return;
  const raw = tlsSocket._parent; // the connection underneath the TLS layer
  if (!raw || raw.destroyed) return;
  const address = String(raw.localAddress || "").replace(/^::ffff:/, "");
  const host = address.includes(":") ? `[${address}]` : address;
  const portPart = WEB_PORT === 443 ? "" : `:${WEB_PORT}`;
  const body = "This site uses HTTPS. Redirecting.";
  raw.end(
    [
      "HTTP/1.1 307 Temporary Redirect",
      `Location: https://${host}${portPart}/`,
      "Content-Type: text/plain",
      `Content-Length: ${body.length}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
}
if (tlsRuntime.current) server.on("tlsClientError", answerPlainHttp);
