// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// LOGGING for SwitchBoard-AV
// Description: The one place that prints. Every line carries the [SwitchBoard-AV] tag; colours only
//   when a person is watching a terminal.
// ===========================================

// Console output. Colours only when a person is watching a terminal (not when piped to a file) and NO_COLOR is unset.
const IS_DEBUG_ENABLED = process.env.DEBUG === "1"; // packet-level logging; off by default
const LOG_TAG = "[SwitchBoard-AV]";

const IS_COLOUR_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paint = (code, text) => (IS_COLOUR_ENABLED ? `\x1b[${code}m${text}\x1b[0m` : text);

export const bold = (t) => paint("1", t);

export const dim = (t) => paint("2", t);

export const yellow = (t) => paint("33", t);

export const green = (t) => paint("32", t);

const clock = () => {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};

// The single output point: nothing else in this file prints.
export function writeLine(text = "") {
  // eslint-disable-next-line no-console -- the one place this file prints
  console.log(text);
}

// Always printed after start-up: warnings, errors and one line per switch result, each with the time and the tag. Low
// volume (user actions only).
export function logEvent(msg) {
  writeLine(`${dim(clock())}  ${LOG_TAG} ${msg}`);
}

// Debug only (DEBUG=1): every UDP / serial packet. Far too chatty for a long-running server with many users.
export function logDebug(msg) {
  if (IS_DEBUG_ENABLED) writeLine(`${dim(clock())}  ${LOG_TAG} ${dim("debug")}  ${msg}`);
}

// A label and a value, with long values wrapped under the value rather than back to the left edge.
const BANNER_LABEL_WIDTH = 14;

export function bannerRow(label, value) {
  // wrap only for a person looking at a terminal; a log file or pipe gets each message on one line
  const width = process.stdout.columns
    ? Math.max(50, process.stdout.columns - BANNER_LABEL_WIDTH - 4)
    : Infinity;
  const lines = [];
  let line = "";
  for (const word of String(value).split(" ")) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else line = line ? line + " " + word : word;
  }
  lines.push(line);
  const pad = " ".repeat(BANNER_LABEL_WIDTH);
  return lines
    .map((l, i) => `  ${i === 0 ? dim(label.padEnd(BANNER_LABEL_WIDTH)) : pad}${l}`)
    .join("\n");
}
