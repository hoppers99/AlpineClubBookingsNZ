import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseStrictHttpHeaders } from "./http-evidence.mjs";

const fail = (message) => { throw new Error(message); };
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function verifyResponse({ root, stem, proof, side, phase, expected, caches }) {
  const parsed = parseStrictHttpHeaders(readFileSync(join(root, `${stem}.headers`), "utf8"), `${side} ${phase} headers`);
  const bodySha = sha256(join(root, `${stem}.body`));
  const nextCache = parsed.headers["x-nextjs-cache"] ?? "ABSENT";
  const etag = parsed.headers.etag ?? null;
  if (parsed.status !== 200 || !caches.includes(nextCache)) fail(`${phase} raw status/cache proof failed`);
  if (expected.body_sha256 !== null && bodySha !== expected.body_sha256) fail(`${phase} raw body checksum failed`);
  if (expected.etag !== null && etag !== expected.etag) fail(`${phase} raw ETag failed`);
  if (
    proof?.schema_version !== 1 || !proof.verified || proof.side !== side || proof.route !== "/about" ||
    proof.phase !== phase || proof.status !== 200 || proof.next_cache !== nextCache ||
    proof.body_sha256 !== bodySha || (proof.etag ?? null) !== etag ||
    JSON.stringify(proof.accepted_cache_values) !== JSON.stringify(caches)
  ) fail(`${phase} proof JSON disagrees with the exact raw response and expected classification`);
}

export function verifyRevalidationEvidence({ root, side, expected }) {
  if (!existsSync(root) || !["current", "baseline"].includes(side)) fail("invalid revalidation verification input");
  const firstProof = json(join(root, "first-proof.json"));
  const firstCaches = side === "current" ? ["STALE"] : ["ABSENT"];
  verifyResponse({ root, stem: "first", proof: firstProof, side, phase: "revalidation-first", expected, caches: firstCaches });

  const commonFiles = ["first.csv", "first.headers", "first.body", "first-proof.json", "window-cpu-usec.csv"];
  if (side === "baseline") {
    const actual = readdirSync(root).sort();
    if (JSON.stringify(actual) !== JSON.stringify(commonFiles.sort())) fail("baseline revalidation contains missing or current-only artifacts");
    return { firstProof, regeneratedProof: null, attempts: [] };
  }

  const attemptProofFiles = readdirSync(root)
    .filter((file) => /^attempt-\d+-proof\.json$/.test(file))
    .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]));
  if (attemptProofFiles.length === 0 || attemptProofFiles.length > 30) fail("current revalidation must contain 1-30 regeneration attempts");
  const expectedFiles = new Set([...commonFiles, "regenerated-proof.json"]);
  const attempts = [];
  for (const [index, file] of attemptProofFiles.entries()) {
    const attempt = index + 1;
    if (file !== `attempt-${attempt}-proof.json`) fail("current revalidation attempt sequence has a gap");
    const stem = `attempt-${attempt}`;
    expectedFiles.add(`${stem}.headers`);
    expectedFiles.add(`${stem}.body`);
    expectedFiles.add(`${stem}-proof.json`);
    const proof = json(join(root, file));
    verifyResponse({ root, stem, proof, side, phase: `revalidation-attempt-${attempt}`, expected, caches: ["STALE", "HIT"] });
    if (attempt < attemptProofFiles.length && proof.next_cache !== "STALE") fail("revalidation reached HIT before the final recorded attempt");
    if (attempt === attemptProofFiles.length && proof.next_cache !== "HIT") fail("final revalidation attempt is not HIT");
    attempts.push(proof);
  }
  const actualFiles = readdirSync(root);
  if (!existsSync(join(root, "regenerated-proof.json"))) fail("current revalidation evidence set is missing regenerated-proof.json");
  if (actualFiles.length !== expectedFiles.size || actualFiles.some((file) => !expectedFiles.has(file))) {
    fail("current revalidation evidence set has missing or unexpected artifacts");
  }
  const regeneratedProof = json(join(root, "regenerated-proof.json"));
  if (JSON.stringify(regeneratedProof) !== JSON.stringify(attempts.at(-1))) fail("regenerated proof is not the exact final HIT attempt");
  return { firstProof, regeneratedProof, attempts };
}
