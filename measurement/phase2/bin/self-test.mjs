import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUDITED_KEYS, LIVE_PROVIDER_KEYS, auditAppEnvironment } from "./audit-app-environment.mjs";
import { correctnessCensus, expectedCheckIdsForSide, sha256File } from "./correctness-contract.mjs";
import { parseStrictHttpHeaders } from "./http-evidence.mjs";
import { MEASURE_ENV_KEYS, auditMeasureEnvFile, createMeasureEnvSnapshot, parseMeasureEnv } from "./measure-env-contract.mjs";
import { FINAL_ORCHESTRATION_PROFILE, FINAL_SIDE_PARAMETERS, PROFILE_FINAL, PROFILE_NONFINAL, assertDeclaredProfile, classifyOrchestrationProfile, classifySideProfile } from "./measurement-profile.mjs";
import { scanEvidence, verifySecretScan } from "./scan-evidence-secrets.mjs";
import { finalizeSealedTree, verifySealedTree } from "./sealed-tree.mjs";
import { conventionalMedian, rankedQuantile } from "./statistics.mjs";
import { verifyCorrectnessCompletion } from "./verify-correctness-evidence.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const bin = resolve(import.meta.dirname);
const temp = mkdtempSync(join(tmpdir(), "issue-2352-phase2-selftest-"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const run = (script, args, options = {}) => execFileSync(process.execPath, [join(bin, script), ...args], { cwd: repo, encoding: "utf8", stdio: "pipe", ...options });
const rejects = (script, args, pattern) => assert.throws(() => run(script, args), pattern);
const mkdirs = (...paths) => paths.forEach((path) => mkdirSync(path, { recursive: true }));

assert.equal(conventionalMedian([4, 1, 3, 2]), 2.5);
assert.equal(rankedQuantile([1, 2, 3, 4], 0.95), 4);
assert.equal(classifySideProfile(FINAL_SIDE_PARAMETERS), PROFILE_FINAL);
assert.equal(classifyOrchestrationProfile(FINAL_ORCHESTRATION_PROFILE), PROFILE_FINAL);
assert.equal(assertDeclaredProfile(PROFILE_NONFINAL, PROFILE_FINAL, "rehearsal"), PROFILE_NONFINAL);
assert.throws(() => assertDeclaredProfile(PROFILE_FINAL, PROFILE_NONFINAL, "weakened"), /weakens or changes/);

const headers = 'HTTP/1.1 103 Early Hints\r\nLink: </x>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nETag: "bound"\r\nX-Nextjs-Cache: HIT\r\n\r\n';
assert.equal(parseStrictHttpHeaders(headers).headers.etag, '"bound"');
for (const duplicate of [
  'HTTP/1.1 200 OK\r\nX-Nextjs-Cache: HIT\r\nx-nextjs-cache: HIT\r\n\r\n',
  'HTTP/1.1 200 OK\r\nETag: "a"\r\netag: "a"\r\n\r\n',
]) assert.throws(() => parseStrictHttpHeaders(duplicate), /duplicate/i);
assert.throws(() => parseStrictHttpHeaders('HTTP/1.1 200 OK\r\n folded\r\n\r\n'), /folded|malformed/i);

const envDir = join(temp, "env-contract");
mkdirs(envDir);
const envValues = Object.fromEntries(MEASURE_ENV_KEYS.map((key) => [key, key === "DB_PASSWORD" ? '"quoted=value"' : key === "APP_IMAGE" ? "fixture@sha256:" + "1".repeat(64) : ""]));
const envPath = join(envDir, ".env.measure");
writeFileSync(envPath, `${MEASURE_ENV_KEYS.map((key) => `${key}=${envValues[key]}`).join("\r\n")}\r\n`);
assert.equal(parseMeasureEnv(envPath).values.DB_PASSWORD, "quoted=value");
assert.doesNotThrow(() => auditMeasureEnvFile(envPath, { ambient: { APP_IMAGE: "ignored-command-selector" } }));
assert.throws(() => auditMeasureEnvFile(envPath, { ambient: { AUTH_SECRET: "override" } }), /ambient environment overrides/);
const snapshotPath = join(envDir, "private.snapshot");
createMeasureEnvSnapshot(envPath, snapshotPath, { ambient: {} });
assert.deepEqual(readFileSync(snapshotPath), readFileSync(envPath));
const duplicateEnv = join(envDir, "duplicate.env");
writeFileSync(duplicateEnv, `${readFileSync(envPath, "utf8")}DB_PASSWORD=again\n`);
assert.throws(() => parseMeasureEnv(duplicateEnv), /duplicate key/);
const controlEnv = join(envDir, "control.env");
writeFileSync(controlEnv, Buffer.concat([readFileSync(envPath), Buffer.from([0])]));
assert.throws(() => parseMeasureEnv(controlEnv), /control bytes/);
try {
  const link = join(envDir, "linked.env"); symlinkSync(envPath, link, "file");
  assert.throws(() => parseMeasureEnv(link), /non-reparse/);
} catch (error) { if (error.code !== "EPERM") throw error; }

const validRuntimeValues = Object.fromEntries(AUDITED_KEYS.map((key) => [key, ""]));
Object.assign(validRuntimeValues, {
  APP_RUNTIME_ROLE: "web-measure", CRON_ENABLED: "false", NODE_ENV: "production", TZ: "Pacific/Auckland", KEEP_ALIVE_TIMEOUT: "65000", LOG_LEVEL: "info",
  AUTH_TRUST_HOST: "true", AUTH_SECRET: "fixture-auth", NEXTAUTH_SECRET: "fixture-auth", CRON_SECRET: "fixture-cron", NEXTAUTH_URL: "http://localhost:8027",
  USE_AWS_SES: "false", USE_SMTP_RELAY: "true", EMAIL_SERVER_HOST: "mailpit", EMAIL_SERVER_PORT: "1025", EMAIL_SERVER_USER: "measurement", EMAIL_SERVER_PASSWORD: "measurement-only", EMAIL_FROM: "noreply@measurement.invalid",
  DATABASE_URL: "postgresql://tac:fixture-db@postgres:5432/tacbookings?connection_limit=10&pool_timeout=10", SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN: "false", BACKUP_CRON_SCHEDULE: "0 3 * * *", MIRO_JWT_EXP: "1h",
});
const inspectFor = (values, extras = {}) => [{ Config: { Env: Object.entries({ ...values, ...extras }).map(([key, value]) => `${key}=${value}`) } }];
const hmacKey = "a".repeat(64);
const runtimeAudit = auditAppEnvironment(inspectFor(validRuntimeValues), hmacKey);
assert.equal(runtimeAudit.verified, true);
assert.equal(runtimeAudit.keyed_fingerprint_sha256, auditAppEnvironment([{ Config: { Env: [...inspectFor(validRuntimeValues)[0].Config.Env].reverse() } }], hmacKey).keyed_fingerprint_sha256);
for (const key of LIVE_PROVIDER_KEYS) assert.throws(() => auditAppEnvironment(inspectFor(validRuntimeValues, { [key]: "live-value" }), hmacKey), /prohibited live-provider/);
assert.throws(() => auditAppEnvironment(inspectFor(validRuntimeValues, { ANTHROPIC_API_KEY: "" }), hmacKey), /unknown provider\/sensitive/);
for (const [key, value] of [["APP_RUNTIME_ROLE", "web"], ["CRON_ENABLED", "true"], ["NEXTAUTH_URL", "https://live.example"], ["AUTH_SECRET", "different"], ["DATABASE_URL", "postgresql://tac:x@other:5432/tacbookings?connection_limit=10&pool_timeout=10"], ["USE_AWS_SES", "true"], ["NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-live"]]) {
  assert.throws(() => auditAppEnvironment(inspectFor({ ...validRuntimeValues, [key]: value }), hmacKey));
}
const duplicatedEnvInspect = inspectFor(validRuntimeValues); duplicatedEnvInspect[0].Config.Env.push("AUTH_SECRET=again");
assert.throws(() => auditAppEnvironment(duplicatedEnvInspect, hmacKey), /duplicate key/);

const databaseAudit = { schema_version: 1, forbidden_integration_credential_count: 0, xero_token_count: 0, club_module_settings_rows: 0, unsafe_club_module_settings_rows: 0, analytics_settings_rows: 0, unsafe_analytics_settings_rows: 0 };
const dbInput = join(temp, "db-audit.json"); writeFileSync(dbInput, JSON.stringify(databaseAudit));
run("verify-database-isolation.mjs", ["--input", dbInput, "--out", join(temp, "db-audit-verified.json")]);
for (const key of ["forbidden_integration_credential_count", "xero_token_count", "unsafe_club_module_settings_rows", "unsafe_analytics_settings_rows"]) {
  const input = join(temp, `db-${key}.json`); writeFileSync(input, JSON.stringify({ ...databaseAudit, [key]: 1 }));
  rejects("verify-database-isolation.mjs", ["--input", input, "--out", join(temp, `db-${key}-out.json`)], /permits a live provider/);
}

const scanRoot = join(temp, "scan-safe"); mkdirs(scanRoot); writeFileSync(join(scanRoot, "safe.txt"), "AUTH_SECRET=${AUTH_SECRET}\nEMAIL_FROM=noreply@measurement.invalid\n");
const scanPath = join(scanRoot, "secret-scan.json");
const scan = scanEvidence({ root: scanRoot, out: scanPath });
verifySecretScan({ root: scanRoot, report: scan });
for (const [name, bytes, pattern] of [
  ["quoted", Buffer.from('AUTH_SECRET="real-secret-material"\n'), /potential secrets/],
  ["argument", Buffer.from('--token "real-command-token"\n'), /potential secrets/],
  ["utf16", Buffer.from('DB_PASSWORD="utf16-secret-material"', "utf16le"), /potential secrets/],
  ["nul-private-key", Buffer.concat([Buffer.from([0]), Buffer.from("-----BEGIN PRIVATE KEY-----")]), /potential secrets/],
]) {
  const root = join(temp, `scan-${name}`); mkdirs(root); writeFileSync(join(root, "evidence.bin"), bytes);
  assert.throws(() => scanEvidence({ root, out: join(root, "secret-scan.json") }), pattern);
}

const sealed = join(temp, "sealed"); mkdirs(join(sealed, "nested")); writeFileSync(join(sealed, "nested", "evidence.txt"), "immutable\n");
finalizeSealedTree({ root: sealed }); verifySealedTree(sealed);
writeFileSync(join(sealed, "extra.txt"), "late\n"); assert.throws(() => verifySealedTree(sealed), /census differs/);
const sealedExtraDir = join(temp, "sealed-extra-dir"); mkdirs(sealedExtraDir); writeFileSync(join(sealedExtraDir, "evidence.txt"), "immutable\n"); finalizeSealedTree({ root: sealedExtraDir }); mkdirSync(join(sealedExtraDir, "empty-extra")); assert.throws(() => verifySealedTree(sealedExtraDir), /census differs/);

const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const sourceArchive = join(temp, "source.tar"); execFileSync("git", ["archive", "--format=tar", `--output=${sourceArchive}`, revision], { cwd: repo });
const databaseArchive = join(temp, "canonical.dump"); writeFileSync(databaseArchive, "canonical database fixture\n");
const producerSource = join(temp, "producer-source.mjs"); writeFileSync(producerSource, "export const producer = true;\n");
const imageId = `sha256:${"b".repeat(64)}`;

function prepareCorrectness(name, side, mutate = {}) {
  const root = join(temp, name); const producerId = `${side}-contract`;
  mkdirs(join(root, "inputs"), join(root, "raw", producerId), join(root, "producer-results"));
  let census = correctnessCensus(name);
  if (mutate.missingCensusId) census = { ...census, checks: census.checks.slice(1) };
  const censusPath = join(root, "inputs", "check-census.json"); writeFileSync(censusPath, `${JSON.stringify(census, null, 2)}\n`);
  const producerManifest = join(root, "inputs", "producer-files.sha256"); writeFileSync(producerManifest, `${sha256File(producerSource)}  ${producerSource}\n`);
  const immutable = {
    schema_version: 1, run_id: name, side,
    source: { commit: revision, archive_path: sourceArchive, archive_sha256: sha256File(sourceArchive) },
    image: { reference: `fixture@${imageId}`, id: imageId, oci_revision: revision },
    database: { archive_path: databaseArchive, archive_sha256: sha256File(databaseArchive), logical_fingerprint: "c".repeat(64) },
    environment: { base_url: "http://127.0.0.1:8027", compose_project: "tacbookings-measure", release_id_sha256: "d".repeat(64) },
    check_census_sha256: sha256File(censusPath), producer_files_sha256: sha256File(producerManifest), created_at: "2026-08-06T00:00:00.000Z",
  };
  writeFileSync(join(root, "inputs", "immutable-inputs.json"), `${JSON.stringify(immutable, null, 2)}\n`);
  if (mutate.changeProducerSource) writeFileSync(producerSource, "export const producer = false;\n");
  const evidencePath = `raw/${producerId}/evidence.txt`; writeFileSync(join(root, ...evidencePath.split("/")), "bound public evidence\n");
  if (mutate.extraRaw) writeFileSync(join(root, "raw", producerId, "extra.txt"), "unreferenced\n");
  const observations = expectedCheckIdsForSide(side).map((checkId) => ({ check_id: checkId, outcome: mutate.notApplicable ? "NOT_APPLICABLE" : "PASS", assertions: ["fixture-assertion"], evidence_paths: [mutate.cyclic ? "raw-evidence-manifest.json" : evidencePath] }));
  const producer = { schema_version: 1, run_id: name, producer_id: producerId, side, started_at: "2026-08-06T00:00:00.000Z", ended_at: "2026-08-06T00:00:01.000Z", exit_code: 0, cleanup: { status: mutate.failedCleanup ? "failed" : "passed", evidence_paths: [evidencePath] }, observations };
  writeFileSync(join(root, "producer-results", `${producerId}.json`), `${JSON.stringify(producer, null, 2)}\n`);
  mkdirSync(join(root, "raw", "orchestrator"));
  const healthPath = "raw/orchestrator/app-health.json";
  writeFileSync(join(root, ...healthPath.split("/")), '{"status":"healthy"}\n');
  writeFileSync(join(root, "postconditions.json"), `${JSON.stringify({ schema_version: 1, run_id: name, side, database_fingerprint_before: immutable.database.logical_fingerprint, database_fingerprint_after: immutable.database.logical_fingerprint, database_unchanged: true, app_health: { status: "passed", evidence_paths: [healthPath] }, completed_at: "2026-08-06T00:00:02.000Z" }, null, 2)}\n`);
  return root;
}

const baselineCorrectness = prepareCorrectness("baseline-pass", "baseline");
run("finalize-correctness-evidence.mjs", ["--dir", baselineCorrectness]);
assert.equal(verifyCorrectnessCompletion(join(baselineCorrectness, "COMPLETED.json")).report.result, "passed");

const currentBlocked = prepareCorrectness("current-blocked", "current");
run("finalize-correctness-evidence.mjs", ["--dir", currentBlocked]);
assert.equal(verifyCorrectnessCompletion(join(currentBlocked, "COMPLETED.json"), { requirePassed: false }).report.result, "owner_disposition_needed");
assert.throws(() => verifyCorrectnessCompletion(join(currentBlocked, "COMPLETED.json")), /complete but not passed/);

for (const [name, mutation, pattern] of [
  ["missing-census", { missingCensusId: true }, /exact reviewed MC\/BND census/],
  ["extra-raw", { extraRaw: true }, /unreferenced/],
  ["unapproved-na", { notApplicable: true }, /producer observation is invalid/],
  ["cyclic-reference", { cyclic: true }, /outside its create-only directory/],
]) {
  const root = prepareCorrectness(name, "baseline", mutation);
  rejects("finalize-correctness-evidence.mjs", ["--dir", root], pattern);
}
const failedCleanup = prepareCorrectness("failed-cleanup", "baseline", { failedCleanup: true });
run("finalize-correctness-evidence.mjs", ["--dir", failedCleanup]);
assert.equal(verifyCorrectnessCompletion(join(failedCleanup, "COMPLETED.json"), { requirePassed: false }).report.result, "failed");
assert.throws(() => verifyCorrectnessCompletion(join(failedCleanup, "COMPLETED.json")), /complete but not passed/);

// Restore the producer source after the dedicated source-binding mutation.
const sourceMutation = prepareCorrectness("source-mutation", "baseline", { changeProducerSource: true });
rejects("finalize-correctness-evidence.mjs", ["--dir", sourceMutation], /producer source binding failed/);
writeFileSync(producerSource, "export const producer = true;\n");

const route = { next_cache: "ABSENT", etag: null, body_sha256: null };
const bindingManifest = {
  schema_version: 1, harness_scope: "issue-2352-phase2",
  canonical_database: { archive_path: databaseArchive, archive_sha256: sha256File(databaseArchive) },
  sides: { baseline: { image_reference: `fixture@${imageId}`, image_id: imageId, oci_revision: revision, source_archive: { path: sourceArchive, sha256: sha256File(sourceArchive) }, correctness_completion: { path: join(baselineCorrectness, "COMPLETED.json"), sha256: sha256File(join(baselineCorrectness, "COMPLETED.json")) }, routes: { "/about": route, "/": route, "/join": route, "/contact": route } } },
};
const bindingManifestPath = join(temp, "binding-manifest.json"); writeFileSync(bindingManifestPath, `${JSON.stringify(bindingManifest)}\n`);
const inspectPath = join(temp, "image-inspect.json"); writeFileSync(inspectPath, `${JSON.stringify([{ Id: imageId, RepoDigests: [`fixture@${imageId}`], Config: { Labels: { "org.opencontainers.image.revision": revision } } }])}\n`);
run("verify-binding.mjs", ["--manifest", bindingManifestPath, "--side", "baseline", "--image-reference", `fixture@${imageId}`, "--image-inspect", inspectPath, "--out", join(temp, "verified-binding.json")]);

const aggregateSource = readFileSync(join(bin, "aggregate-pairs.mjs"), "utf8");
for (const contract of ["finalProfileExact", "observations.length === 4", "PRELIMINARY_ONLY", "OWNER_REVIEW_REQUIRED", "isFuturePathInside", "common_runtime_environment_hmac_sha256", "autonomous_progression_authorised: false"]) assert.match(aggregateSource, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const orchestrationSource = readFileSync(join(bin, "orchestrate-pairs.sh"), "utf8");
for (const contract of ["PAIR_COUNT:-4", "MAX_INTER_SIDE_GAP_SECONDS:-600", "MAX_INTER_PAIR_GAP_SECONDS:-600", "QUIET_MONITOR_INTERVAL_SECONDS:-10", "final-decision orchestration profile cannot weaken"]) assert.match(orchestrationSource, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

console.log("phase-2 self-test: all contract mutations were rejected");
