import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const fail = (message) => { throw new Error(message); };
const manifestPath = resolve(process.argv[2] ?? "");
if (!existsSync(manifestPath)) fail("usage: verify-harness-manifest.mjs <manifest>");
const records = readFileSync(manifestPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
if (records.length === 0) fail("harness manifest is empty");
const seen = new Set();
for (const [index, line] of records.entries()) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match) fail(`invalid harness manifest line ${index + 1}`);
  if (!isAbsolute(match[2])) fail(`harness manifest path is not absolute on line ${index + 1}`);
  const path = resolve(match[2]);
  if (/(?:^|[\\/])\.env\.measure$/i.test(path)) fail(".env.measure must never enter the frozen harness manifest");
  if (seen.has(path)) fail(`duplicate harness file: ${path}`);
  seen.add(path);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`harness file is missing: ${path}`);
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== match[1]) fail(`harness file changed: ${path}`);
}
const root = resolve(import.meta.dirname, "../../..");
const expected = new Set([
  ...readdirSync(import.meta.dirname, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => resolve(import.meta.dirname, entry.name)),
  resolve(root, "docker-compose.yml"),
  resolve(root, "Caddyfile.staging"),
  resolve(root, "measurement/stack/docker-compose.measure.yml"),
  resolve(root, "measurement/stack/measure-stack.sh"),
]);
if (seen.size !== expected.size || [...seen].some((path) => !expected.has(path))) fail("harness manifest does not contain the exact complete reviewed harness file set");
console.log(JSON.stringify({ schema_version: 1, files: records.length, verified: true }));
