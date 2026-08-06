import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStrictHttpHeaders } from "./http-evidence.mjs";
import { canonicalRelative, sha256File } from "./correctness-contract.mjs";

const fail = (message) => { throw new Error(message); };
const ROUTES = Object.freeze(["/about", "/", "/join", "/contact"]);
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(`${label} has an invalid schema`);
};
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const expectedSamples = (side) => ({
  "/about": side === "current"
    ? [["miss", "binding-about-1"], ["hit", "binding-about-2"]]
    : [["first", "binding-about-1"], ["second", "binding-about-2"]],
  "/": [["request", "binding-root"]],
  "/join": [["request", "binding-join"]],
  "/contact": [["request", "binding-contact"]],
});

export function verifyCorrectnessRouteEvidence(root, immutable, rawEntries) {
  const evidencePath = "raw/cms-lifecycle/route-response-evidence.json";
  const evidenceEntry = rawEntries.get(evidencePath);
  if (!evidenceEntry || evidenceEntry.producer_id !== "cms-lifecycle" || !evidenceEntry.check_ids.includes("BND-02")) fail("typed route response evidence is not sealed under the reviewed BND-02 producer");
  const value = JSON.parse(readFileSync(join(root, ...evidencePath.split("/")), "utf8"));
  exactKeys(value, ["schema_version", "side", "image_id", "routes"], "typed route response evidence");
  if (value.schema_version !== 1 || value.side !== immutable.side || value.image_id !== immutable.image.id) fail("typed route response evidence identity is invalid");
  exactKeys(value.routes, ROUTES, "typed route response census");
  const samplesByRoute = expectedSamples(immutable.side);
  const derived = {};
  for (const route of ROUTES) {
    const routeValue = value.routes[route];
    exactKeys(routeValue, ["samples", "derived"], `typed route ${route}`);
    if (!Array.isArray(routeValue.samples) || routeValue.samples.length !== samplesByRoute[route].length) fail(`typed route ${route} has the wrong sample count`);
    const parsedSamples = routeValue.samples.map((sample, index) => {
      exactKeys(sample, ["phase", "headers_path", "body_path"], `typed route ${route} sample ${index}`);
      const [phase, stem] = samplesByRoute[route][index];
      const expectedHeaders = `raw/cms-lifecycle/${stem}.headers`;
      const expectedBody = `raw/cms-lifecycle/${stem}.body.html`;
      if (sample.phase !== phase || canonicalRelative(sample.headers_path, `${route} headers`) !== expectedHeaders || canonicalRelative(sample.body_path, `${route} body`) !== expectedBody) fail(`typed route ${route} sample ${index} differs from the reviewed capture schema`);
      for (const path of [expectedHeaders, expectedBody]) {
        const entry = rawEntries.get(path);
        if (!entry || entry.producer_id !== "cms-lifecycle") fail(`typed route source is not sealed under its reviewed producer: ${path}`);
      }
      const headers = parseStrictHttpHeaders(readFileSync(join(root, ...expectedHeaders.split("/")), "utf8"), `${route} ${phase} correctness headers`);
      return { status: headers.status, next_cache: headers.headers["x-nextjs-cache"] ?? null, etag: headers.headers.etag ?? null, body_sha256: sha256File(join(root, ...expectedBody.split("/"))) };
    });
    if (parsedSamples.some((sample) => sample.status !== 200)) fail(`typed route ${route} did not return HTTP 200`);
    let expectedDerived;
    if (route === "/about" && immutable.side === "current") {
      const [miss, hit] = parsedSamples;
      if (miss.next_cache !== "MISS" || hit.next_cache !== "HIT" || !miss.etag || miss.etag !== hit.etag || miss.body_sha256 !== hit.body_sha256) fail("current /about correctness capture is not a stable MISS/HIT pair");
      expectedDerived = { status: 200, next_cache: "HIT", etag: hit.etag, body_sha256: hit.body_sha256 };
    } else {
      if (parsedSamples.some((sample) => sample.next_cache !== null)) fail(`${immutable.side} ${route} unexpectedly emitted x-nextjs-cache`);
      if (route === "/about" && parsedSamples[0].body_sha256 !== parsedSamples[1].body_sha256) fail("baseline /about correctness responses are not byte-identical");
      expectedDerived = { status: 200, next_cache: "ABSENT", etag: null, body_sha256: null };
    }
    exactKeys(routeValue.derived, ["status", "next_cache", "etag", "body_sha256"], `typed route ${route} derived result`);
    if (JSON.stringify(routeValue.derived) !== JSON.stringify(expectedDerived)) fail(`typed route ${route} derived result was not independently reproduced`);
    if (expectedDerived.body_sha256 !== null && !hex(expectedDerived.body_sha256)) fail(`typed route ${route} body checksum is invalid`);
    derived[route] = expectedDerived;
  }
  return { evidencePath, evidenceSha256: sha256File(join(root, ...evidencePath.split("/"))), routes: derived };
}
