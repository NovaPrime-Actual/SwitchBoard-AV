// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// HTTPS RUNTIME for SwitchBoard-AV
// Description: The certificate in use, swapping in a renewed one without a restart, and the optional
//   plain-HTTP redirect. HTTPS is on by default (see tls.js). Off only with TLS=off, or TRUST_PROXY=1 when a
//   proxy does the TLS. Certificate: server settings (TLS_CERT/TLS_KEY/TLS_PFX), then one uploaded in the
//   admin Security tab, then a self-signed one the app makes itself. Anything unusable falls back to the next;
//   never to plain HTTP.
// ===========================================

import http from "node:http";
import { BIND_ADDRESS, DATA_DIR, WEB_PORT } from "./config.js";
import { logEvent } from "./log.js";
import { logActivity } from "./store.js";
import * as tlsSetup from "./tls.js";

export const HTTP_REDIRECT_PORT = process.env.HTTP_REDIRECT_PORT
  ? Number(process.env.HTTP_REDIRECT_PORT)
  : 0;

const tlsConfig = tlsSetup.setup(process.env, DATA_DIR);

// The certificate in use and the running server it is installed in (shared with the Security tab).
export const tlsRuntime = { current: null, server: null };

if (tlsConfig) {
  try {
    tlsRuntime.current = tlsConfig.build();
  } catch (err) {
    logEvent(`ERROR: HTTPS is switched on but cannot start: ${err.message}`);
    process.exit(1);
  }
}

// Answers a plain-HTTP request with a redirect to the HTTPS address. The Host header is checked against a
// strict pattern first so it cannot be used to bounce people to another site.
const HOST_PATTERN = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d+)?$/;
function redirectToHttps(req, res) {
  const m = HOST_PATTERN.exec(String(req.headers.host || ""));
  if (!m || !String(req.url || "").startsWith("/")) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Bad request");
  }
  const portPart = WEB_PORT === 443 ? "" : `:${WEB_PORT}`;
  res.writeHead(307, {
    Location: `https://${m[1]}${portPart}${req.url}`,
    "Content-Type": "text/plain",
  });
  res.end("This site uses HTTPS. Redirecting.");
}

// An extra port (HTTP_REDIRECT_PORT, e.g. 80) that only redirects. Plain HTTP typed at the HTTPS port itself
// is redirected too, see webserver.js.
export function startHttpRedirect() {
  const redirector = http.createServer(redirectToHttps);
  redirector.on("error", (err) => {
    logEvent(
      `WARNING: could not start the HTTP->HTTPS redirect on port ${HTTP_REDIRECT_PORT}: ${err.message}`,
    );
  });
  redirector.listen(HTTP_REDIRECT_PORT, BIND_ADDRESS, () => {
    logEvent(`http://...:${HTTP_REDIRECT_PORT} now redirects to https://...:${WEB_PORT}`);
  });
}

// Re-reads the certificate and, if it changed, swaps it into the running server (no restart).
// Returns true when a different certificate is now being served.
export function reloadTls(buildOpts) {
  const next = tlsConfig.build(buildOpts);
  const changed = next.sig !== tlsRuntime.current.sig;
  if (changed) tlsRuntime.server.setSecureContext(next.options);
  tlsRuntime.current = next;
  return changed;
}

// Picks up a renewed certificate (or a self-signed one regenerated near expiry) without a restart.
export function watchCertificate() {
  let lastProblem = tlsRuntime.current.info.fallbackReason || "";
  const timer = setInterval(
    () => {
      try {
        // keepReal: never swap a working real certificate for the self-signed one just because a file is broken
        if (reloadTls({ keepReal: tlsRuntime.current.info.kind !== "selfsigned" })) {
          logEvent(`HTTPS certificate reloaded (${tlsRuntime.current.info.source})`);
          logActivity({ type: "tls_reload", by: "system", detail: "HTTPS certificate reloaded" });
        }
        lastProblem = "";
      } catch (err) {
        if (err.message !== lastProblem) {
          lastProblem = err.message;
          logEvent(
            `WARNING: could not reload the HTTPS certificate, still using the current one: ${err.message}`,
          );
        }
      }
    },
    Math.max(1, Number(process.env.TLS_RELOAD_SECONDS) || 3600) * 1000,
  );
  timer.unref();
}
