import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

function fail(message) { throw new Error(message); }
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) fail(`--${name} is required`);
  return process.argv[index + 1];
}
function sha256Buffer(value) { return createHash("sha256").update(value).digest("hex"); }
function filesBelow(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return filesBelow(root, path);
    if (!entry.isFile()) fail(`unsupported output entry: ${path}`);
    return [path];
  });
}

const root = resolve(arg("dir"));
const side = arg("side");
const pairId = arg("pair-id");
const manifestPath = resolve(root, "output-manifest.sha256");
const completionPath = resolve(root, "COMPLETED.json");
if (!statSync(root).isDirectory()) fail(`run directory is missing: ${root}`);
const excluded = new Set([manifestPath, completionPath]);
const records = filesBelow(root)
  .filter((path) => !excluded.has(path))
  .map((path) => ({
    path: relative(root, path).split(sep).join("/"),
    bytes: statSync(path).size,
    sha256: sha256Buffer(readFileSync(path)),
  }))
  .sort((left, right) => left.path.localeCompare(right.path));
if (records.length === 0) fail("refusing to complete an empty run");
const lines = records.map((record) => `${record.sha256}  ${record.bytes}  ${record.path}`);
writeFileSync(manifestPath, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
const manifestSha = sha256Buffer(readFileSync(manifestPath));
const completion = {
  schema_version: 1,
  completion_id: randomUUID(),
  pair_id: pairId,
  side,
  completed_at: new Date().toISOString(),
  output_manifest_sha256: manifestSha,
  artifact_count: records.length,
  status: "COMPLETE",
};
writeFileSync(completionPath, `${JSON.stringify(completion, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify(completion));
