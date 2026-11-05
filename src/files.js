// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// FILES for SwitchBoard-AV
// Description: Reading and atomically writing the JSON files kept in the data folder.
// ===========================================

import fs from "node:fs";

export function loadJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

export function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  // On Windows the rename can fail for a moment (EPERM/EBUSY) when antivirus or an indexer has the target
  // open, so retry a few times with a short pause before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
    }
  }
}
