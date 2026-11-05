// ===========================================
// SWITCHBOARD-AV  v2.12
// Description: Local web app that switches Visionary decoders to an encoder over UDP,
//   with a readback check. Serves public/index.html (+ app.js, tokens.css, style.css) and a small JSON API.
//   Per-user accounts, roles (admin/manager/user) and access groups scope which decoders
//   and sources each person may see and switch; enforced server-side. Version history is
//   in CHANGELOG.md.
// Author: Brett Cupp
// Copyright (c) 2026 Brett Cupp
// SPDX-License-Identifier: AGPL-3.0-or-later
//   This program is free software: you can redistribute it and/or modify it under the terms of the
//   GNU Affero General Public License as published by the Free Software Foundation, either version 3
//   of the License, or (at your option) any later version. It is distributed in the hope that it will
//   be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
//   FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License (the LICENSE file)
//   for more details. Additional terms under section 7 of that license (the name and logo, and the
//   credit "SwitchBoard-AV by Brett Cupp") are in the NOTICE file and TRADEMARKS.md.
// Last Update: 11/04/26
//
// Run:  node server.js        then open https://localhost:8080  (your browser will warn about the
//   self-signed certificate until an admin installs a real one; use TLS=off for plain http)
// Config: devices.json is only read on a new server setup: the starting device list is imported and
//   port / decoderPort are copied into DATA_DIR/settings.json (edit that file, then restart, to change them)
//   (decoders, encoders; optional per decoder "tvPower": "lg", "tvSetId": "00"). After that
//   the list lives in DATA_DIR/devices.store.json next to accounts, groups and activity
//   (DATA_DIR defaults to ./data), edited in the app.
// Env overrides: DEVICES_FILE, DATA_DIR, PORT (overrides settings.json), DEBUG (1 = log every packet), BIND, TRUST_PROXY, TV_SERIAL_PORT, STATUS_POLL_SECONDS,
//   TLS (off | selfsigned), TLS_HOSTS, TLS_CERT, TLS_KEY, TLS_PFX, TLS_PASSPHRASE, TLS_RELOAD_SECONDS,
//   HTTP_REDIRECT_PORT, HSTS, SOURCE_URL, SESSION_IDLE_MINUTES, SESSION_MAX_HOURS
// No npm packages needed (Node built-ins only).
// ===========================================

import path from "node:path";
import { hashPassword, pruneSessions } from "./src/auth.js";
import {
  APP_VERSION,
  BIND_ADDRESS,
  DATA_DIR,
  DEVICES_FILE,
  TV_PROTOCOLS,
  WEB_PORT,
} from "./src/config.js";
import { config, deviceListSource, historyKeep, trimDeviceHistory } from "./src/devicelist.js";
import { bannerRow, bold, dim, green, logEvent, writeLine, yellow } from "./src/log.js";
import { tidyGroupManagers } from "./src/scoping.js";
import { logActivity, saveStore, store } from "./src/store.js";
import {
  HTTP_REDIRECT_PORT,
  startHttpRedirect,
  tlsRuntime,
  watchCertificate,
} from "./src/tls-runtime.js";
import { genId, genTempPassword } from "./src/util.js";
import { IS_HSTS_ENABLED, server } from "./src/webserver.js";

async function bootstrapAdmin() {
  if (Object.keys(store.users).length > 0) return;
  const tempPassword = genTempPassword();
  const { salt, hash } = await hashPassword(tempPassword);
  const id = genId("u");
  store.users[id] = {
    id,
    username: "admin",
    name: "Administrator",
    role: "admin",
    groups: [],
    passwordHash: hash,
    passwordSalt: salt,
    mustChangePassword: true,
    disabled: false,
    createdAt: Date.now(),
  };
  saveStore();
  // Printed with writeLine on purpose: logDebug is gated by DEBUG and this must never be silent.
  writeLine("");
  writeLine(bold(yellow("  FIRST RUN: the admin account was created")));
  writeLine("    username: admin");
  writeLine(`    temporary password: ${bold(tempPassword)}`);
  writeLine(dim("  You will be asked to choose a new password when you first sign in."));
}

async function main() {
  await bootstrapAdmin();
  setInterval(pruneSessions, 5 * 60 * 1000).unref(); // forget ended sessions and old failed-sign-in counts
  // a history saved under an older, longer limit is trimmed to the current one
  trimDeviceHistory(historyKeep());
  // one-off tidy of managers saved before demotion removed them automatically
  const tidied = tidyGroupManagers();
  if (tidied) {
    saveStore();
    logActivity({
      type: "admin_group_update",
      by: "system",
      group: `${tidied} group${tidied === 1 ? "" : "s"}`,
      detail: "removed managers who no longer hold the Manager role",
    });
  }
  server.listen(WEB_PORT, BIND_ADDRESS, () => {
    const scheme = tlsRuntime.current ? "https" : "http";
    const url = `${scheme}://${BIND_ADDRESS === "0.0.0.0" ? "localhost" : BIND_ADDRESS}:${WEB_PORT}`;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const tvReady = config.decoders.filter((d) => TV_PROTOCOLS[d.tvPower]).length;
    const fileName = path.basename(DEVICES_FILE);
    const screens = plural(config.decoders.length, "screen", "screens");
    const sources = plural(config.encoders.length, "source", "sources");

    const rows = [
      ["Screens", `${screens}, ${sources}, ${tvReady} with TV power`],
      [
        "Device list",
        deviceListSource === "imported"
          ? `imported ${screens} and ${sources} from ${fileName}; from now on edit them in the app`
          : `saved in the data folder (${fileName} is only read the first time the app starts)`,
      ],
      ["Data folder", DATA_DIR],
    ];
    const notes = []; // [text, isWarning] lines under the table
    if (tlsRuntime.current) {
      const i = tlsRuntime.current.info;
      const kind =
        i.kind === "selfsigned"
          ? "self-signed certificate"
          : i.kind === "uploaded"
            ? "certificate uploaded in the admin screen"
            : i.source;
      const until = i.validTo
        ? new Date(i.validTo).toLocaleDateString("en-US", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })
        : "";
      rows.push([
        "HTTPS",
        `on: ${kind}${i.created ? " (newly made)" : ""}${until ? `, valid until ${until}` : ""}${i.expired ? " *** EXPIRED ***" : ""}`,
      ]);
      if (i.fingerprint) rows.push(["Cert SHA-256", i.fingerprint]);
      if (i.selfSigned) rows.push(["Names", (i.hosts || i.names || []).join(", ")]);
      if (i.fallbackReason) {
        notes.push([
          `WARNING: the certificate you configured could not be used: ${i.fallbackReason}`,
          true,
        ]);
        notes.push([
          "Using a self-signed certificate for now. Fix the files and the real certificate is picked up within the hour (TLS_RELOAD_SECONDS), no restart needed.",
          false,
        ]);
      }
      if (i.selfSigned)
        notes.push([
          "Browsers will show a warning for a self-signed certificate until it is trusted on each device. An admin can install a real certificate in Users > Security.",
          false,
        ]);
      if (IS_HSTS_ENABLED && i.selfSigned)
        notes.push([
          "WARNING: HSTS is on with a self-signed certificate; browsers will not let people click past the warning.",
          true,
        ]);
    } else {
      rows.push(["HTTPS", "off (plain HTTP)"]);
      if (HTTP_REDIRECT_PORT)
        notes.push(["HTTP_REDIRECT_PORT is ignored because HTTPS is not on.", false]);
      if (IS_HSTS_ENABLED) notes.push(["HSTS is ignored because HTTPS is not on.", false]);
      if (
        BIND_ADDRESS !== "127.0.0.1" &&
        BIND_ADDRESS !== "localhost" &&
        !(process.env.TRUST_PROXY === "1")
      ) {
        notes.push([
          "NOTE: HTTPS is switched off (TLS=off) and the app is listening on the network over plain HTTP; passwords and sessions are readable on the wire.",
          true,
        ]);
      }
    }
    for (const d of config.decoders) {
      if (d.tvPower && !TV_PROTOCOLS[d.tvPower])
        notes.push([
          `WARNING: ${d.name} (${d.ip}) has unknown tvPower "${d.tvPower}" — ignored`,
          true,
        ]);
    }

    // Printed with writeLine on purpose: this must never be silent, whatever DEBUG is.
    writeLine("");
    writeLine(`  ${bold("SwitchBoard-AV")} ${dim("v" + APP_VERSION)}`);
    writeLine(dim("  " + "-".repeat(46)));
    for (const [label, value] of rows) writeLine(bannerRow(label, value));
    if (notes.length) {
      writeLine("");
      const width = process.stdout.columns ? Math.max(50, process.stdout.columns - 4) : Infinity;
      for (const [text, warn] of notes) {
        let line = "";
        const lines = [];
        for (const word of text.split(" ")) {
          if (line && (line + " " + word).length > width) {
            lines.push(line);
            line = word;
          } else line = line ? line + " " + word : word;
        }
        lines.push(line);
        for (const l of lines) writeLine(`  ${warn ? yellow(l) : l}`);
      }
    }
    writeLine("");
    writeLine(`  ${bold(green(`Open ${url}`))}`);
    writeLine("");
    if (tlsRuntime.current) {
      watchCertificate();
      if (HTTP_REDIRECT_PORT) startHttpRedirect();
    }
  });
}

main().catch((err) => {
  logEvent(`ERROR: start-up failed: ${err.stack || err.message}`);
  process.exit(1);
});
