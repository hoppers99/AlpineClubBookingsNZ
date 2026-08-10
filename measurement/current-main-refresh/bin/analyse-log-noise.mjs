import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const out = resolve(args.get("--out") ?? (() => { throw new Error("--out is required"); })());
const files = process.argv.slice(process.argv.indexOf("--logs") + 1).filter((value) => !value.startsWith("--"));
if (files.length === 0 || process.argv.indexOf("--logs") < 0) throw new Error("--logs requires at least one file");
const requiredOwners = new Set(["cache-fault", "cms-lifecycle", "browser-suite", "wire-security", "stored-404", "public-layout-writers", "setup-transition", "revalidation-300s", "warm-db", "adult-hosting", "deploy-warmup"]);
const records = [];
const signatures = new Map();
const normalize = (line) => line.toLowerCase()
  .replace(/\b[0-9a-f]{32,}\b/g, "<hex>")
  .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<uuid>")
  .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
  .replace(/\s+/g, " ").trim();
for (const file of files) {
  const absolute = resolve(file);
  const normalizedPath = absolute.replaceAll("\\", "/");
  const owner = normalizedPath.match(/\/raw\/([^/]+)\//)?.[1];
  if (!owner) throw new Error(`log is not producer-owned raw evidence: ${absolute}`);
  requiredOwners.delete(owner);
  for (const [index, line] of readFileSync(absolute, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let level = null;
    try {
      const parsed = JSON.parse(line);
      if (Number(parsed.level) >= 60) level = "fatal";
      else if (Number(parsed.level) >= 50) level = "error";
      else if (Number(parsed.level) >= 40) level = "warning";
    } catch { /* text logs are classified below */ }
    const lower = line.toLowerCase();
    if (!level && /\b(fatal|panic|uncaught|unhandled)\b/.test(lower)) level = "fatal";
    else if (!level && /\b(error|exception|failed)\b/.test(lower)) level = "error";
    else if (!level && /\bwarn(?:ing)?\b/.test(lower)) level = "warning";
    if (!level) continue;
    const expectedFault = owner === "cache-fault" && /(enospc|no space left on device)/i.test(line);
    const signature = normalize(line);
    records.push({ owner, line: index + 1, level, expected_fault: expectedFault, signature });
    if (!expectedFault) signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
}
if (requiredOwners.size) throw new Error(`missing scenario logs: ${[...requiredOwners].sort().join(",")}`);
const sustained = [...signatures].filter(([, count]) => count >= 3).map(([signature, count]) => ({ signature, count }));
const fatal = records.filter((record) => !record.expected_fault && record.level === "fatal");
if (sustained.length || fatal.length) throw new Error(`sustained/fatal log noise detected: ${JSON.stringify({ sustained, fatal })}`);
writeFileSync(out, JSON.stringify({
  schema_version: 1,
  log_files: files.map((file) => resolve(file)),
  classified_lines: records,
  non_fault_warning_error_count: records.filter((record) => !record.expected_fault).length,
  expected_cache_fault_line_count: records.filter((record) => record.expected_fault).length,
  sustained_signatures: sustained,
  fatal_lines: fatal,
  passed: true,
}, null, 2) + "\n", { flag: "wx" });
