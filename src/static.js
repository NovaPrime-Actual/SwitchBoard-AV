// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// STATIC FILE SERVER for SwitchBoard-AV
// Description: Serves the files in public/ (html, js, css, images) and nothing else.
// ===========================================

import fs from "node:fs";
import path from "node:path";
import { renderIndexHtml } from "./branding.js";
import { STATIC_ROOT, STATIC_TYPES } from "./config.js";

export function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  const resolved = path.normalize(path.join(STATIC_ROOT, rel));
  if (resolved !== STATIC_ROOT && !resolved.startsWith(STATIC_ROOT + path.sep)) {
    res.writeHead(404);
    return res.end();
  }
  const type = STATIC_TYPES[path.extname(resolved).toLowerCase()];
  if (!type) {
    res.writeHead(404);
    return res.end();
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    if (resolved === path.join(STATIC_ROOT, "index.html")) {
      // the name / logo placeholders are filled in from the Branding settings
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      return res.end(renderIndexHtml(data.toString("utf8")));
    }
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}
