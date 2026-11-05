// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// STORE for SwitchBoard-AV
// Description: data/store.json (users and groups) and data/activity.json (the activity log).
// ===========================================

import { ACTIVITY_CAP, ACTIVITY_PATH, STORE_PATH } from "./config.js";
import { atomicWrite, loadJsonFile } from "./files.js";

export const store = loadJsonFile(STORE_PATH, { users: {}, groups: {} });

export let activity = loadJsonFile(ACTIVITY_PATH, []);

export function saveStore() {
  atomicWrite(STORE_PATH, store);
}

export function logActivity(entry) {
  activity.push({ at: Date.now(), ...entry });
  if (activity.length > ACTIVITY_CAP) activity = activity.slice(activity.length - ACTIVITY_CAP);
  atomicWrite(ACTIVITY_PATH, activity);
}
