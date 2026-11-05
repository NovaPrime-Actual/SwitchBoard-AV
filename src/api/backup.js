// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// BACKUP API for SwitchBoard-AV
// Description: Admin only: the full backup download (a .zip of the data folder's state files).
// ===========================================

import * as backup from "../backup.js";
import { branding } from "../branding.js";
import { APP_VERSION, DATA_DIR } from "../config.js";
import { reply } from "../http.js";
import { logActivity } from "../store.js";

export function handleAdminBackup(req, res, user) {
  if (user.role !== "admin") return reply(res, 403, { error: "Admins only" });
  if (req.method !== "GET") return reply(res, 404, { error: "Not found" });
  const created = new Date();
  const files = backup.collectFiles(DATA_DIR);
  const kept = files.length;
  files.push({
    name: "RESTORE.txt",
    data: Buffer.from(
      backup.restoreNote({
        appName: branding.appName,
        created: created.toISOString(),
        by: user.username,
        version: APP_VERSION,
      }),
      "utf8",
    ),
    mtime: created,
  });
  const zip = backup.makeZip(files);
  logActivity({
    type: "backup_download",
    by: user.username,
    detail: `downloaded a full backup (${kept} files)`,
  });
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="switchboard-av-backup-${created.toISOString().slice(0, 10)}.zip"`,
    "Content-Length": zip.length,
    "Cache-Control": "no-store",
  });
  return res.end(zip);
}
