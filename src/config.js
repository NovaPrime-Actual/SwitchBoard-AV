// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// CONFIG for SwitchBoard-AV
// Description: Settings read once at start-up (environment, devices.json seed, data folder paths, limits).
// ===========================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, loadJsonFile } from "./files.js";
import { logEvent } from "./log.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONFIRM_DELAY_MS = 500;

// wait after switch before first query
export const CONFIRM_RETRY_MS = 1500;

// wait before a second query, if the first mismatches
export const MAX_CONFIRM_ATTEMPTS = 2;

// How often open pages refresh what the screens are showing (seconds); 0 turns auto-refresh off.
const pollEnv = process.env.STATUS_POLL_SECONDS;

export const STATUS_POLL_SECONDS =
  pollEnv !== undefined && pollEnv !== "" && Number.isFinite(Number(pollEnv))
    ? Math.max(0, Number(pollEnv))
    : 20;

export const HEALTH_PROBE_MS = 1200;

// how long the admin health check waits for a device to answer
export const HEALTH_CONCURRENCY = 24;

// how many devices the health check asks at once
export const MAX_BATCH_SCREENS = 100;

// most screens one "switch several at once" request may include
export const APP_VERSION = "2.15";

// shown in the About window; keep in step with the version line in the header comment
// The code's own notice, shown in the About window (the AGPL asks interactive programs to show the copyright, the
// lack of warranty and where to read the license). Not branding. A changed version should set SOURCE_URL to where its
// source code can be had: the AGPL (section 13) says people using a modified version over a network may ask for it.
export const APP_LICENSE = {
  id: "AGPL-3.0-or-later",
  name: "GNU Affero General Public License, version 3 or later",
  copyright: "Copyright (c) 2026 Brett Cupp",
};

const UPSTREAM_SOURCE_URL = "https://github.com/NovaPrime-Actual/SwitchBoard-AV"; // the unmodified program's source
export const APP_SOURCE_URL = /^https?:\/\/[^\s"'<>]+$/.test(process.env.SOURCE_URL || "")
  ? process.env.SOURCE_URL
  : UPSTREAM_SOURCE_URL;

export const BATCH_CONCURRENCY = 12;

// how many of those are switched and confirmed at the same time
export const QUERY_TIMEOUT_MS = 1000;

// how long to wait for a query reply
export const TESTER_TIMEOUT_MS = 2000;

// how long the Query tester waits for any reply
// Read-only diagnostics queries the decoder's own diagnostics.html uses (sent as QUERY.<name>=TRUE).
// Fixed list on purpose: the same page also holds reset / firmware update / save commands.
export const DIAG_QUERIES = [
  "ALL",
  "VIDEO_TIMING",
  "TEMPERATURE",
  "NETWORK_INFO",
  "AUDIO_INFO",
  "USB_INFO",
];

// TV power over the decoder's RS-232 port. With SERIAL.ENABLED=TRUE on the decoder, a TCP session to
// port 6752 is written out of its serial port (9600 8N1 for the LG TVs, set on the decoder itself).
// Each exchange opens a connection, sends one command, reads the reply and closes.
export const TV_SERIAL_PORT = process.env.TV_SERIAL_PORT
  ? Number(process.env.TV_SERIAL_PORT)
  : 6752;

export const TV_TIMEOUT_MS = 2500;

// connect + reply budget for one exchange
export const TV_RETRY_DELAY_MS = 400;

// pause before the one retry (all commands here are safe to repeat)
// The inputs an E5200 encoder can be asked to use (STREAM.VIDEO: AUTO, HDMI1, HDMI2, USB-C, per the manual).
export const INPUT_CHOICES = ["HDMI1", "HDMI2", "USB-C", "AUTO"];

// One entry per TV protocol. A decoder opts in with "tvPower": "<name>" in devices.json, so
// enabling more screens later is a one-line change per decoder, and a new brand is a new entry here.
export const TV_PROTOCOLS = {
  lg: {
    defaultSetId: "00", // 00 = every set; override per decoder with "tvSetId"
    command: {
      on: (id) => `ka ${id} 01\r`,
      off: (id) => `ka ${id} 00\r`,
      status: (id) => `ka ${id} ff\r`,
    },
    // Reply is "a 00 OK01x" (power on), "a 00 OK00x" (off) or "a 00 NG..x" (rejected).
    complete: (buf) => /(OK|NG)[0-9a-f]{2}x/i.test(buf),
    parse: (buf) => {
      const m = buf.match(/a\s+[0-9a-f]+\s+(OK|NG)([0-9a-f]{2})/i);
      return m ? { ok: m[1].toUpperCase() === "OK", on: m[2] === "01" } : null;
    },
  },
};

export const DEVICES_FILE = process.env.DEVICES_FILE
  ? path.resolve(process.env.DEVICES_FILE)
  : path.join(APP_ROOT, "devices.json");

// Every network address by default, so a server install works as soon as it starts. BIND=127.0.0.1 keeps it to the
// computer it runs on (for example behind a reverse proxy on the same machine).
export const BIND_ADDRESS = process.env.BIND || "0.0.0.0";

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(APP_ROOT, "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

// devices.json is only read on a new server setup: its device list is imported once, and its
// port / decoderPort are copied once into DATA_DIR/settings.json. After that the app runs from the
// data folder alone (an admin can also restore the list from an uploaded file in the Devices screen).
export function readSeedFile() {
  try {
    return JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
  } catch (e) {
    logEvent(`WARNING: no starting settings were read from ${DEVICES_FILE}: ${e.message}`);
    return {};
  }
}

const validPort = (v, fallback) =>
  Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 65535 ? Number(v) : fallback;

const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

let settings = loadJsonFile(SETTINGS_PATH, null);

if (!settings) {
  const seed = readSeedFile();
  settings = { port: validPort(seed.port, 8080), decoderPort: validPort(seed.decoderPort, 8000) };
  atomicWrite(SETTINGS_PATH, settings);
}

export const DECODER_PORT = validPort(settings.decoderPort, 8000);

// UDP port the decoders listen on
export const WEB_PORT = process.env.PORT
  ? Number(process.env.PORT)
  : validPort(settings.port, 8080);

// PORT env still overrides
export const STORE_PATH = path.join(DATA_DIR, "store.json");

export const ACTIVITY_PATH = path.join(DATA_DIR, "activity.json");

export const ACTIVITY_CAP = 2000;

export const DEVICES_STORE_PATH = path.join(DATA_DIR, "devices.store.json");

export const DEVICE_HISTORY_PATH = path.join(DATA_DIR, "devices-history.json");

// How many earlier versions of the screens/sources list are kept for "Restore". An admin picks one of these in the
// Backup tab (kept in store.json under settings); older versions are dropped as new ones are saved.
export const HISTORY_CHOICES = [5, 10, 15, 20];

export const HISTORY_DEFAULT = 10;

// Login throttle: free attempts before a lockout kicks in, then exponential backoff.
export const THROTTLE_FREE_ATTEMPTS = 3;

export const THROTTLE_MAX_LOCK_MS = 60000;

export const STATIC_ROOT = path.join(APP_ROOT, "public");

export const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
