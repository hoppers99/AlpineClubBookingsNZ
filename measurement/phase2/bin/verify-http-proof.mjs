// Verifies one captured response against the correctness manifest. This is run
// immediately before and after every cgroup CPU block.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) { throw new Error(message); }
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) fail(`--${name} is required`);
  return process.argv[index + 1];
}
function sha256Buffer(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function parseHeaders(text) {
  // curl may preserve an interim response; the last HTTP block is authoritative.
  const blocks = text.trim().split(/\r?\n\r?\n(?=HTTP\/)/i);
  const lines = blocks.at(-1).split(/\r?\n/);
  const match = /^HTTP\/\S+\s+(\d+)/i.exec(lines.shift() ?? "");
  if (!match) fail("captured headers have no HTTP status line");
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number(match[1]), headers };
}

const manifestPath = resolve(arg("manifest"));
const side = arg("side");
const route = arg("route");
const phase = arg("phase");
const headersPath = resolve(arg("headers"));
const bodyPath = resolve(arg("body"));
const out = resolve(arg("out"));
const overrideIndex = process.argv.indexOf("--expected-cache");
const expectedCaches = overrideIndex >= 0
  ? process.argv[overrideIndex + 1].split("|")
  : null;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const expected = manifest.sides?.[side]?.routes?.[route];
if (!expected) fail(`no correctness expectation for ${side} ${route}`);
const parsed = parseHeaders(readFileSync(headersPath, "utf8"));
const bodySha = sha256Buffer(readFileSync(bodyPath));
const nextCache = parsed.headers["x-nextjs-cache"] ?? "ABSENT";
const etag = parsed.headers.etag;
if (parsed.status !== 200) fail(`${side} ${route} ${phase}: expected status 200, got ${parsed.status}`);
if (expected.body_sha256 !== null && bodySha !== expected.body_sha256) fail(`${side} ${route} ${phase}: body checksum changed`);
if (expected.etag !== null && etag !== expected.etag) fail(`${side} ${route} ${phase}: ETag changed or absent`);
const acceptedCaches = expectedCaches ?? [expected.next_cache];
if (!acceptedCaches.includes(nextCache)) {
  fail(`${side} ${route} ${phase}: expected X-Nextjs-Cache ${acceptedCaches.join(" or ")}, got ${nextCache}`);
}
if (!expectedCaches && side === "current" && route === "/about" && nextCache !== "HIT") {
  fail("current /about was not an exact cache HIT");
}
if (!expectedCaches && (side === "baseline" || route !== "/about") && nextCache !== "ABSENT") {
  fail(`${side} ${route} did not prove the intended dynamic classification`);
}
const result = {
  schema_version: 1,
  side,
  route,
  phase,
  status: parsed.status,
  next_cache: nextCache,
  accepted_cache_values: acceptedCaches,
  etag,
  body_sha256: bodySha,
  cache_control: parsed.headers["cache-control"] ?? null,
  verified: true,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
