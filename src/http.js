// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// HTTP HELPERS for SwitchBoard-AV
// Description: Reading a JSON body, answering JSON, and the status snapshot the page polls.
// ===========================================

import { STATUS_POLL_SECONDS } from "./config.js";
import { config } from "./devicelist.js";
import { logDebug } from "./log.js";
import {
  inputControlEncoderSet,
  multiSwitchDecoderSet,
  screenControlDecoderSet,
  tvPowerDecoderSet,
  visibleDecoderSet,
  visibleSourceSet,
} from "./scoping.js";
import { busy, inputState, lastKnown, reachability, screenState, tvState } from "./state.js";

export function readJson(req, maxChars = 10000) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      body += c;
      if (body.length > maxChars) {
        tooBig = true;
        body = "";
      }
    });
    req.on("end", () => {
      if (tooBig) return reject(new Error("Request too large"));
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (err) {
        reject(new Error("Bad JSON", { cause: err }));
      }
    });
  });
}

// Reads the request body as JSON; on failure answers 400 itself and returns null so the caller just stops.
export async function readJsonOrRefuse(req, res) {
  try {
    return await readJson(req);
  } catch (err) {
    logDebug(`Rejected request body: ${err.message}`);
    reply(res, 400, { error: "Bad JSON" });
    return null;
  }
}

export function reply(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// decoders[] / sources[] as the caller's scope permits, with last known encoder host
export function snapshot(user) {
  const decIps = visibleDecoderSet(user);
  const srcIps = visibleSourceSet(user);
  const powerIps = tvPowerDecoderSet(user);
  const screenIps = screenControlDecoderSet(user);
  const inputIps = inputControlEncoderSet(user);
  const multiIps = multiSwitchDecoderSet(user);
  return {
    decoders: config.decoders
      .filter((d) => decIps.has(d.ip))
      .map((d) => {
        const known = lastKnown.get(d.ip);
        const tv = tvState.get(d.ip);
        return {
          ip: d.ip,
          name: d.name,
          space: d.space || "Unassigned",
          host: known ? known.host : null,
          reachable: reachability.has(d.ip) ? reachability.get(d.ip) : null, // null = not queried yet
          busy: busy.has(d.ip),
          canPower: powerIps.has(d.ip), // this user may use TV power on this screen
          tvOn: tv ? tv.on : null, // last known TV power state, null = unknown
          canMulti: multiIps.has(d.ip), // this screen may be picked together with others ("select several")
          canScreen: screenIps.has(d.ip), // this user may blank this screen / put a message on it
          output: screenState.has(d.ip) ? screenState.get(d.ip).output || null : null, // NORMAL, STANDBY (black), LOGO, OFF
        };
      }),
    pollSeconds: STATUS_POLL_SECONDS, // how often the page should refresh on its own (0 = never)
    sources: config.encoders
      .filter((e) => srcIps.has(e.ip))
      .map((e) => {
        const can = inputIps.has(e.ip);
        return {
          ip: e.ip,
          name: e.name,
          space: e.space || null, // set = a local source, only for screens in that space
          canInput: can,
          inputs: can ? e.inputs : [],
          input: can && inputState.has(e.ip) ? inputState.get(e.ip).input : null,
        };
      }),
  };
}
