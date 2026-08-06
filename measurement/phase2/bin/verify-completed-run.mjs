import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) { throw new Error(message); }
const root = resolve(process.argv[2] ?? "");
if (!root || !existsSync(root) || !statSync(root).isDirectory()) fail("usage: verify-completed-run.mjs <run-dir>");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const manifestPath = resolve(root, "output-manifest.sha256");
const completionPath = resolve(root, "COMPLETED.json");
if (!existsSync(manifestPath) || !existsSync(completionPath)) fail(`incomplete run: ${root}`);
const completion = JSON.parse(readFileSync(completionPath, "utf8"));
if (completion.status !== "COMPLETE" || hash(manifestPath) !== completion.output_manifest_sha256) {
  fail(`invalid completion marker: ${root}`);
}
let count = 0;
for (const [index, line] of readFileSync(manifestPath, "utf8").trim().split(/\r?\n/).entries()) {
  const match = /^([a-f0-9]{64})  (\d+)  (.+)$/.exec(line);
  if (!match) fail(`invalid output manifest line ${index + 1}`);
  const path = resolve(root, match[3]);
  if (!path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) fail(`manifest path escapes run: ${match[3]}`);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`manifest file missing: ${match[3]}`);
  if (statSync(path).size !== Number(match[2]) || hash(path) !== match[1]) fail(`manifest mismatch: ${match[3]}`);
  count += 1;
}
if (count !== completion.artifact_count) fail("completion artifact count mismatch");
console.log(JSON.stringify(completion));
