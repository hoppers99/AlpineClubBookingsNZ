// Validates every interior request in one timed warm CPU block.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseStrictHttpHeaders } from "./http-evidence.mjs";

const fail = (message) => { throw new Error(message); };
const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) fail(`--${name} is required`);
  return process.argv[index + 1];
};
const manifestPath = resolve(arg("manifest"));
const side = arg("side");
const route = arg("route");
const evidenceDir = resolve(arg("evidence-dir"));
const timingCsv = resolve(arg("timing-csv"));
const expectedSamples = Number(arg("samples"));
const out = resolve(arg("out"));
if (!Number.isInteger(expectedSamples) || expectedSamples <= 0) fail("--samples must be a positive integer");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const expected = manifest.sides?.[side]?.routes?.[route];
if (!expected) fail(`manifest has no ${side} ${route} expectation`);
const timingLines = readFileSync(timingCsv, "utf8").trim().split(/\r?\n/).filter(Boolean);
if (timingLines.length !== expectedSamples) fail(`timing CSV has ${timingLines.length} rows, expected ${expectedSamples}`);
const expectedFiles = new Set(Array.from({ length: expectedSamples }, (_, index) => index + 1).flatMap((sample) => [`sample-${sample}.headers`, `sample-${sample}.body`]));
const actualFiles = readdirSync(evidenceDir);
if (actualFiles.length !== expectedFiles.size || actualFiles.some((file) => !expectedFiles.has(file))) fail("warm evidence files are missing or unexpected");
const samples = [];
for (let sample = 1; sample <= expectedSamples; sample += 1) {
  const parsed = parseStrictHttpHeaders(readFileSync(resolve(evidenceDir, `sample-${sample}.headers`), "utf8"), `${side} ${route} warm sample ${sample} headers`);
  const bodySha = createHash("sha256").update(readFileSync(resolve(evidenceDir, `sample-${sample}.body`))).digest("hex");
  const nextCache = parsed.headers["x-nextjs-cache"] ?? "ABSENT";
  const etag = parsed.headers.etag;
  const timing = timingLines[sample - 1].split(",");
  if (timing.length !== 3 || Number(timing[0]) !== 200 || parsed.status !== 200) fail(`sample ${sample} is not status 200`);
  if (![Number(timing[1]), Number(timing[2])].every((value) => Number.isFinite(value) && value >= 0) || Number(timing[2]) < Number(timing[1])) fail(`sample ${sample} timing is invalid`);
  if (nextCache !== expected.next_cache) fail(`sample ${sample} cache classification changed: expected ${expected.next_cache}, got ${nextCache}`);
  if (expected.body_sha256 !== null && bodySha !== expected.body_sha256) fail(`sample ${sample} body checksum changed`);
  if (expected.etag !== null && etag !== expected.etag) fail(`sample ${sample} ETag changed`);
  samples.push({ sample, status: 200, next_cache: nextCache, etag: etag ?? null, body_sha256: bodySha });
}
writeFileSync(out, `${JSON.stringify({ schema_version: 1, side, route, samples: expectedSamples, all_verified: true, evidence: samples }, null, 2)}\n`, "utf8");
