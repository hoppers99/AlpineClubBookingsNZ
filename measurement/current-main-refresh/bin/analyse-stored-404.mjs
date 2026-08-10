import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const required = (name) => {
  const value = args.get(`--${name}`);
  if (!value) throw new Error(`--${name} is required`);
  return resolve(value);
};
const read = (name) => readFileSync(required(name), "utf8");
const headerNonce = (headers, label) => {
  const policies = headers.split(/\r?\n/).filter((line) => /^content-security-policy\s*:/i.test(line));
  if (policies.length !== 1) throw new Error(`${label}: expected one CSP header, got ${policies.length}`);
  const nonces = [...policies[0].matchAll(/'nonce-([^']+)'/g)].map((match) => match[1]);
  if (nonces.length === 0 || new Set(nonces).size !== 1) throw new Error(`${label}: inconsistent policy nonces`);
  return nonces[0];
};
const bodyNonce = (body, label) => {
  const scripts = [...body.matchAll(/<script\b([^>]*)>/gi)];
  if (scripts.length === 0) throw new Error(`${label}: no executable document scripts found`);
  const nonces = scripts.map((match) => /\bnonce=["']([^"']+)["']/i.exec(match[1])?.[1]);
  if (nonces.some((nonce) => !nonce)) throw new Error(`${label}: an executable script has no nonce`);
  if (new Set(nonces).size !== 1) throw new Error(`${label}: document scripts do not share one nonce`);
  return nonces[0];
};
const status = ["first-status", "second-status", "cleared-status"].map((name) => read(name).trim());
if (status.some((value) => value !== "404")) throw new Error(`expected three 404s, got ${status.join(",")}`);
const firstHeaders = read("first-headers");
const secondHeaders = read("second-headers");
const clearedHeaders = read("cleared-headers");
const firstBody = read("first-body");
const secondBody = read("second-body");
const clearedBody = read("cleared-body");
if (firstBody !== secondBody) throw new Error("second response did not reuse the stored 404 document");
const firstPolicyNonce = headerNonce(firstHeaders, "first");
const secondPolicyNonce = headerNonce(secondHeaders, "second");
const clearedPolicyNonce = headerNonce(clearedHeaders, "cleared");
const firstDocumentNonce = bodyNonce(firstBody, "first");
const secondDocumentNonce = bodyNonce(secondBody, "second");
const clearedDocumentNonce = bodyNonce(clearedBody, "cleared");
if (firstPolicyNonce !== firstDocumentNonce) throw new Error("generated 404 policy/document nonces differ");
if (secondDocumentNonce !== firstDocumentNonce || secondPolicyNonce === secondDocumentNonce) {
  throw new Error("stored 404 did not exhibit the accepted later-policy/document mismatch");
}
if (clearedPolicyNonce !== clearedDocumentNonce || clearedDocumentNonce === firstDocumentNonce) {
  throw new Error("the clearing trigger did not produce a fresh, internally consistent 404 document");
}
const browser = JSON.parse(read("browser"));
if (browser.schema_version !== 1 || browser.status !== 404 || browser.visible_character_count !== 0 || browser.visible_text !== "") {
  throw new Error("browser-visible stored 404 was not blank");
}
writeFileSync(required("out"), JSON.stringify({
  schema_version: 1,
  statuses: status.map(Number),
  first: { policy_nonce: firstPolicyNonce, document_nonce: firstDocumentNonce },
  second: { policy_nonce: secondPolicyNonce, document_nonce: secondDocumentNonce },
  after_clearing_trigger: { policy_nonce: clearedPolicyNonce, document_nonce: clearedDocumentNonce },
  stored_body_byte_equal: true,
  visible_character_count: 0,
  accepted_residual_observed: true,
}, null, 2), { flag: "wx" });
