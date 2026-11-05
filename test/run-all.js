// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every *.test.js script in this folder, one after another (they use fixed local ports, so not at the same time).
//
//   node test/run-all.js                 run everything
//   node test/run-all.js tls hardening   only the files whose names contain one of these words
//   node test/run-all.js --verbose       show each script's full output, not just a summary
//
// The tests start their own copies of the app and the pretend decoders on 127.x addresses, in temporary
// folders. They never touch your real data folder and never talk to real equipment. A script that needs a
// tool this machine does not have (for example openssl) prints SKIP for those checks and carries on.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const words = args.filter((a) => !a.startsWith("--"));
const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => words.length === 0 || words.some((w) => f.includes(w)))
  .sort();

if (files.length === 0) {
  console.log("No test files match.");
  process.exit(1);
}

let failed = 0;
const started = Date.now();
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const ok = r.status === 0 && !/^FAIL\b/m.test(out);
  const skips = (out.match(/^SKIP\b.*$/gm) || []).length;
  const summary = (
    out
      .trim()
      .split("\n")
      .filter((l) => /passed|PASS$/.test(l))
      .pop() || ""
  ).trim();
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${f.padEnd(26)} ${String(secs).padStart(3)}s  ${summary}${skips ? `  (${skips} skipped)` : ""}`,
  );
  if (!ok) {
    failed++;
    const lines = out.split("\n");
    const bad = lines.filter((l) => /^FAIL\b|CRASH|Error/.test(l));
    console.log(
      (verbose ? lines : bad.length ? bad : lines.slice(-15)).map((l) => "      " + l).join("\n"),
    );
  } else if (verbose) {
    console.log(
      out
        .split("\n")
        .map((l) => "      " + l)
        .join("\n"),
    );
  }
}
const total = ((Date.now() - started) / 1000).toFixed(0);
console.log(
  `\n${files.length - failed} of ${files.length} test files passed in ${total}s${failed ? `; ${failed} failed` : ""}.`,
);
process.exit(failed ? 1 : 0);
