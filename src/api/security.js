// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// SECURITY API for SwitchBoard-AV
// Description: Admin only: the HTTPS certificate (Security tab): status, upload, download, reset.
// ===========================================

import fs from "node:fs";
import net from "node:net";
import { DATA_DIR } from "../config.js";
import { readJson, reply } from "../http.js";
import { logDebug, logEvent } from "../log.js";
import { logActivity } from "../store.js";
import { reloadTls, tlsRuntime } from "../tls-runtime.js";
import * as tlsSetup from "../tls.js";

function requestHostName(req) {
  return String(req.headers.host || "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
}

function certCovers(x509, host) {
  if (!x509 || !host) return null;
  try {
    return (net.isIP(host) ? x509.checkIP(host) : x509.checkHost(host)) !== undefined;
  } catch (err) {
    logDebug(`Certificate name check failed: ${err.message}`);
    return null;
  }
}

function tlsStatus(req) {
  if (!tlsRuntime.current) {
    return { enabled: false, proxied: process.env.TRUST_PROXY === "1" };
  }
  const i = tlsRuntime.current.info;
  return {
    enabled: true,
    kind: i.kind, // "server-settings" | "uploaded" | "selfsigned"
    source: i.source,
    selfSigned: Boolean(i.selfSigned),
    subject: i.subject || null,
    issuer: i.issuer || null,
    names: i.names || [],
    validTo: i.validTo || null,
    daysLeft: typeof i.daysLeft === "number" ? i.daysLeft : null,
    expired: Boolean(i.expired),
    fingerprint: i.fingerprint || null,
    fallbackReason: i.fallbackReason || null,
    address: requestHostName(req),
    coversThisAddress: certCovers(tlsRuntime.current.x509, requestHostName(req)),
    canDownload: Boolean(tlsRuntime.current.options.cert),
    hasUploaded: fs.existsSync(tlsSetup.uploadedPaths(DATA_DIR).cert),
    lockedBySettings: i.kind === "server-settings",
  };
}

export async function handleAdminTls(req, res, user, rest) {
  if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
  if (rest.length === 0 && req.method === "GET") return reply(res, 200, tlsStatus(req));
  if (!tlsRuntime.current) {
    return reply(res, 400, {
      error:
        "HTTPS is switched off for this server (TLS=off or a proxy in front), so there is no certificate to manage here.",
    });
  }
  if (rest[0] === "certificate" && req.method === "GET") {
    if (!tlsRuntime.current.options.cert)
      return reply(res, 404, {
        error:
          "This server uses a .pfx file; the public certificate cannot be downloaded from here.",
      });
    res.writeHead(200, {
      "Content-Type": "application/x-pem-file",
      "Content-Disposition": 'attachment; filename="switchboard-av-certificate.pem"',
    });
    return res.end(tlsRuntime.current.options.cert);
  }
  if (rest[0] === "upload" && req.method === "POST") {
    if (tlsRuntime.current.info.kind === "server-settings") {
      return reply(res, 400, {
        error:
          "The certificate is set by the server's own settings (TLS_CERT / TLS_KEY / TLS_PFX), which take priority. Remove those settings to manage the certificate here.",
      });
    }
    let body;
    try {
      body = await readJson(req, 200000);
    } catch (err) {
      return reply(res, 400, {
        error:
          err.message === "Request too large"
            ? "Those files are too large to be a certificate and key."
            : "Bad request",
      });
    }
    let checked;
    try {
      checked = tlsSetup.inspectUpload(
        body.cert,
        body.key,
        body.passphrase ? String(body.passphrase) : undefined,
      );
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    const address = requestHostName(req);
    const detail = {
      ...checked.summary,
      address,
      coversThisAddress: certCovers(checked.x509, address),
    };
    if (body.dryRun) return reply(res, 200, { ok: true, dryRun: true, ...detail });
    const hadUploaded = fs.existsSync(tlsSetup.uploadedPaths(DATA_DIR).cert);
    let backup = null;
    if (hadUploaded) {
      const p = tlsSetup.uploadedPaths(DATA_DIR);
      backup = { cert: fs.readFileSync(p.cert, "utf8"), key: fs.readFileSync(p.key, "utf8") };
    }
    try {
      tlsSetup.saveUploaded(DATA_DIR, checked);
      reloadTls({});
      if (tlsRuntime.current.info.kind !== "uploaded")
        throw new Error(tlsRuntime.current.info.fallbackReason || "the server would not use it");
    } catch (err) {
      // put things back exactly as they were
      try {
        if (backup) tlsSetup.saveUploaded(DATA_DIR, { certPem: backup.cert, keyPem: backup.key });
        else tlsSetup.removeUploaded(DATA_DIR);
        reloadTls({});
      } catch (rollbackErr) {
        logEvent(`Could not restore the previous certificate: ${rollbackErr.message}`);
      }
      return reply(res, 500, { error: `The certificate could not be installed: ${err.message}` });
    }
    logActivity({
      type: "tls_upload",
      by: user.username,
      detail: `installed a certificate for ${detail.names.slice(0, 5).join(", ") || detail.subject}, expires ${new Date(detail.validTo).toISOString().slice(0, 10)}`,
    });
    return reply(res, 200, { ok: true, ...tlsStatus(req) });
  }
  if (rest[0] === "reset" && req.method === "POST") {
    if (tlsRuntime.current.info.kind === "server-settings") {
      return reply(res, 400, {
        error:
          "The certificate is set by the server's own settings, not uploaded here, so there is nothing to reset.",
      });
    }
    tlsSetup.removeUploaded(DATA_DIR);
    try {
      reloadTls({});
    } catch (err) {
      return reply(res, 500, { error: err.message });
    }
    logActivity({
      type: "tls_reset",
      by: user.username,
      detail: "went back to the self-signed certificate",
    });
    return reply(res, 200, { ok: true, ...tlsStatus(req) });
  }
  return reply(res, 404, { error: "Not found" });
}
