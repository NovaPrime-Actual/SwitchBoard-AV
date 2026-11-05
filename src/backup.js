// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// BACKUP for SwitchBoard-AV
// Description: Builds a .zip of everything the app keeps in its data folder (accounts, groups, the
//   screen and source list and its history, settings, branding and the activity log), with Node
//   built-ins only. The zip is a plain copy of those files, so restoring is: stop the app, unzip
//   into the data folder, start the app. It deliberately leaves out the HTTPS key and certificate
//   files (data/tls) and anything temporary.
// Used by server.js (admin Backup tab).
// ===========================================

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// Files in the data folder that make up the app's state. Anything else (tls/, *.tmp) is left out on purpose.
const dataFiles = [
  "store.json",
  "settings.json",
  "devices.store.json",
  "devices-history.json",
  "branding.json",
  "activity.json",
];

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ name, data: Buffer, mtime: Date }] -> Buffer holding a zip file (deflate where it helps)
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const packed = zlib.deflateRawSync(raw);
    const useDeflate = packed.length < raw.length;
    const body = useDeflate ? packed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { time, date } = dosStamp(e.mtime || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // made by
    cd.writeUInt16LE(20, 6); // needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// Reads the app's state files from the data folder. Every change the app makes is written to disk at
// once, so this is current. Missing files are simply left out.
function collectFiles(dataDir) {
  const out = [];
  const add = (rel, abs) => {
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) out.push({ name: rel, data: fs.readFileSync(abs), mtime: st.mtime });
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // an optional file that does not exist yet is skipped
    }
  };
  for (const f of dataFiles) add(f, path.join(dataDir, f));
  const brandDir = path.join(dataDir, "branding");
  try {
    for (const f of fs.readdirSync(brandDir)) {
      if (/^logo\.(png|jpg|gif|webp)$/.test(f)) add(`branding/${f}`, path.join(brandDir, f));
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // no branding folder yet
  }
  return out;
}

function restoreNote(info) {
  return [
    `${info.appName} backup`,
    `Made ${info.created} by ${info.by}, version ${info.version}.`,
    "",
    "WHAT IS IN HERE",
    "  store.json            user accounts (with their password hashes) and access groups",
    "  devices.store.json    the screens, sources and spaces",
    "  devices-history.json  the saved earlier versions of that list (for Restore)",
    "  settings.json         ports and other starting settings",
    "  branding.json         app name, organization name and colours",
    "  branding/logo.*       the logo, if one was uploaded",
    "  activity.json         the activity log",
    "",
    "KEEP THIS FILE PRIVATE. It holds everyone's accounts and password hashes.",
    "It does not include the HTTPS certificate or key (the app makes a new self-signed one, or you",
    "upload your certificate again in Users > Security).",
    "",
    "TO RESTORE",
    "  1. Stop the app.",
    "  2. Unzip this file into the app's data folder (the 'data' folder next to server.js, or whatever",
    "     DATA_DIR points at), replacing the files with the same names.",
    "  3. Start the app. People sign in with the same passwords as when the backup was made.",
    "",
  ].join("\n");
}

export { makeZip, collectFiles, restoreNote, crc32 };
