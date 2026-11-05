// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// STATE for SwitchBoard-AV
// Description: The live, in-memory picture of the decoders: reachability, what each one last said,
//   and which are busy. Nothing here is saved to disk.
// ===========================================

import dgram from "node:dgram";

export const udp = dgram.createSocket("udp4");

export const queryWaiters = new Map();

// decoder ip -> array of resolve functions
export const lastKnown = new Map();

// decoder ip -> { host, at }
export const reachability = new Map();

// decoder ip -> true (answered the last query) / false (timed out)
export const busy = new Set();

// decoder ips with a route in progress
export const lastReply = new Map();

// device ip -> when (ms) it last sent us any reply
export const healthCache = new Map();

// device ip -> { ok, ms, model, at } from the last admin health check
export const healthRuns = new Map();

// scope key ("all" or "user:<name>") -> the health check in progress, shared by callers
export const inputBusy = new Set();

// encoder ips with an input change in progress
export const inputState = new Map();

// encoder ip -> { input } from the last read or confirmed change
export const screenBusy = new Set();

// decoder ips with a blank / message command in progress
export const screenState = new Map();

// decoder ip -> { output, osd } from the last read or confirmed command
export const tvBusy = new Set();

// decoder ips with a TV power command in progress
export const tvState = new Map();

// decoder ip -> { on, at } from the last TV reply
export const rawWaiters = new Map();
