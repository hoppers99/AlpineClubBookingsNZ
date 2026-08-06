import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const fail = (message) => { throw new Error(message); };
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(`${label} has an invalid schema`);
};
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function validateRuntimeIdentity(value, label = "runtime identity") {
  exactKeys(value, ["schema_version", "app", "postgres", "verified"], label);
  exactKeys(value.app, ["container_id", "image_id"], `${label} app`);
  exactKeys(value.postgres, ["container_id", "image_id", "server_version"], `${label} Postgres`);
  if (value.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(value.app.container_id ?? "") || !/^sha256:[a-f0-9]{64}$/.test(value.app.image_id ?? "") || !/^[a-f0-9]{64}$/.test(value.postgres.container_id ?? "") || !/^sha256:[a-f0-9]{64}$/.test(value.postgres.image_id ?? "") || typeof value.postgres.server_version !== "string" || !/^16(?:\.|$)/.test(value.postgres.server_version) || value.verified !== true) fail(`${label} is invalid`);
  return value;
}

export function verifyPostFinalizationRuntimeIdentity(path, { claimedSha256, expected }) {
  if (!/^[a-f0-9]{64}$/.test(claimedSha256 ?? "") || sha256(path) !== claimedSha256) fail("post-finalization runtime identity checksum differs from the sealed pair claim");
  const actual = validateRuntimeIdentity(JSON.parse(readFileSync(path, "utf8")), "post-finalization runtime identity");
  const expectedIdentity = validateRuntimeIdentity(expected, "sealed side runtime identity");
  if (JSON.stringify(actual) !== JSON.stringify(expectedIdentity)) fail("post-finalization runtime identity differs semantically from the sealed side identity");
  return { value: actual, sha256: claimedSha256 };
}
