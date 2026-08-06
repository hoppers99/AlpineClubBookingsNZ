import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUDITED_KEYS, LIVE_PROVIDER_KEYS, auditAppEnvironment } from "./audit-app-environment.mjs";
import { CORRECTNESS_CENSUS, EXPECTED_PRODUCER_SOURCE_PATHS, PHASE2_DEFERRED_CHECK_IDS, buildPhase2Correctness, classifyPreTimingResult, correctnessCensus, sha256File, validateCensus, validatePhase2Correctness, validateProducerFilesManifest, validateProducerResult } from "./correctness-contract.mjs";
import { parseStrictHttpHeaders } from "./http-evidence.mjs";
import { readGitArchive } from "./git-archive.mjs";
import { verifyCorrectnessRouteEvidence } from "./correctness-route-evidence.mjs";
import { compareStackIdentities, verifyStackIdentity } from "./correctness-stack-identity.mjs";
import { MEASURE_ENV_KEYS, auditMeasureEnvFile, createMeasureEnvSnapshot, parseMeasureEnv, verifyMeasureEnvSnapshot } from "./measure-env-contract.mjs";
import { FINAL_ORCHESTRATION_PROFILE, FINAL_SIDE_PARAMETERS, PROFILE_FINAL, PROFILE_NONFINAL, assertDeclaredProfile, classifyOrchestrationProfile, classifySideProfile } from "./measurement-profile.mjs";
import { scanEvidence, verifySecretScan } from "./scan-evidence-secrets.mjs";
import { finalizeSealedTree, verifySealedTree } from "./sealed-tree.mjs";
import { conventionalMedian, rankedQuantile } from "./statistics.mjs";
import { verifyPostFinalizationRuntimeIdentity } from "./runtime-identity.mjs";
import { verifyHarnessAgainstProducerArchive } from "./verify-harness-source.mjs";

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
const snapshotKey = "9".repeat(64);
const snapshotAudit = createMeasureEnvSnapshot(envPath, snapshotPath, { ambient: {}, key: snapshotKey });
assert.deepEqual(readFileSync(snapshotPath), readFileSync(envPath));
assert.doesNotThrow(() => verifyMeasureEnvSnapshot(snapshotPath, { ambient: {}, key: snapshotKey, expectedHmac: snapshotAudit.snapshot_hmac_sha256 }));
writeFileSync(snapshotPath, readFileSync(snapshotPath, "utf8").replace('DB_PASSWORD="quoted=value"', 'DB_PASSWORD="changed=value"'));
assert.throws(() => verifyMeasureEnvSnapshot(snapshotPath, { ambient: {}, key: snapshotKey, expectedHmac: snapshotAudit.snapshot_hmac_sha256 }), /changed after it was frozen/);
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
for (const key of ["NODE_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) assert.throws(() => auditAppEnvironment(inspectFor(validRuntimeValues, { [key]: "http://proxy.invalid" }), hmacKey), /unapproved influential/);
assert.notEqual(runtimeAudit.keyed_fingerprint_sha256, auditAppEnvironment(inspectFor(validRuntimeValues, { HARMLESS_IMAGE_METADATA: "changed" }), hmacKey).keyed_fingerprint_sha256);
const invalidDatabaseSecret = "not-a-url-private-material";
assert.throws(() => auditAppEnvironment(inspectFor({ ...validRuntimeValues, DATABASE_URL: invalidDatabaseSecret }), hmacKey), (error) => /not a valid isolated/.test(error.message) && !error.message.includes(invalidDatabaseSecret));
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

const scanRoot = join(temp, "scan-safe"); mkdirs(scanRoot); writeFileSync(join(scanRoot, "safe.txt"), "AUTH_SECRET=${AUTH_SECRET}\nSOME_API_KEY=placeholder\nTOKEN_COUNT=1\nEMAIL_FROM=noreply@measurement.invalid\n");
const scanPath = join(scanRoot, "secret-scan.json");
const scan = scanEvidence({ root: scanRoot, out: scanPath });
verifySecretScan({ root: scanRoot, report: scan });
for (const [name, bytes, pattern] of [
  ["quoted", Buffer.from('AUTH_SECRET="real-secret-material"\n'), /potential secrets/],
  ["argument", Buffer.from('--token "real-command-token"\n'), /potential secrets/],
  ["utf16", Buffer.from('DB_PASSWORD="utf16-secret-material"', "utf16le"), /potential secrets/],
  ["nul-private-key", Buffer.concat([Buffer.from([0]), Buffer.from("-----BEGIN PRIVATE KEY-----")]), /potential secrets/],
  ["sentry", Buffer.from("NEXT_PUBLIC_SENTRY_DSN=https://publickey@o1.ingest.sentry.io/123\n"), /potential secrets/],
  ["ai-diagnostics", Buffer.from("AI_DIAGNOSTICS_DATABASE_URL=postgresql://ai:private@remote/db\n"), /potential secrets/],
  ["legacy", Buffer.from("LEGACY_DASHBOARD_EXPORT_TOKEN=legacy-private-token\n"), /potential secrets/],
  ["miro", Buffer.from("MIRO_JWT_KEY=miro-private-material\n"), /potential secrets/],
  ["xero", Buffer.from("XERO_WEBHOOK_KEY=xero-private-material\n"), /potential secrets/],
  ["generic-aws", Buffer.from("AWS_SECRET_ACCESS_KEY=aws-private-material\n"), /potential secrets/],
  ["aws-session", Buffer.from("AWS_SESSION_TOKEN=very-private-session-token-material\n"), /potential secrets/],
  ["aws-security", Buffer.from("AWS_SECURITY_TOKEN=very-private-security-token-material\n"), /potential secrets/],
  ["anthropic", Buffer.from("ANTHROPIC_API_KEY=anthropic-private-material\n"), /potential secrets/],
  ["generic-api-key", Buffer.from("SOME_API_KEY=generic-private-material\n"), /potential secrets/],
  ["backup", Buffer.from("BACKUP_S3_SECRET_ACCESS_KEY=backup-private-material\n"), /potential secrets/],
  ["allowed-substring", Buffer.from("AUTH_SECRET=real-measurement-secret\n"), /potential secrets/],
  ["nul-split", Buffer.from("A\0U\0T\0H\0_\0S\0E\0C\0R\0E\0T\0=\0n\0u\0l\0-\0s\0p\0l\0i\0t\0-\0s\0e\0c\0r\0e\0t\n"), /potential secrets/],
]) {
  const root = join(temp, `scan-${name}`); mkdirs(root); writeFileSync(join(root, "evidence.bin"), bytes);
  assert.throws(() => scanEvidence({ root, out: join(root, "secret-scan.json") }), pattern);
}

const sealed = join(temp, "sealed"); mkdirs(join(sealed, "nested")); writeFileSync(join(sealed, "nested", "evidence.txt"), "immutable\n");
finalizeSealedTree({ root: sealed }); verifySealedTree(sealed);
writeFileSync(join(sealed, "extra.txt"), "late\n"); assert.throws(() => verifySealedTree(sealed), /census differs/);
const sealedExtraDir = join(temp, "sealed-extra-dir"); mkdirs(sealedExtraDir); writeFileSync(join(sealedExtraDir, "evidence.txt"), "immutable\n"); finalizeSealedTree({ root: sealedExtraDir }); mkdirSync(join(sealedExtraDir, "empty-extra")); assert.throws(() => verifySealedTree(sealedExtraDir), /census differs/);

assert.doesNotThrow(() => validateCensus(correctnessCensus()));
assert.throws(() => validateCensus({ ...correctnessCensus(), checks: correctnessCensus().checks.slice(1) }), /exact reviewed MC\/BND census/);
const preTimingChecks = CORRECTNESS_CENSUS.filter((check) => check.required_sides.includes("current")).map((check) => PHASE2_DEFERRED_CHECK_IDS.current.includes(check.id)
  ? { id: check.id, applicability: "deferred_to_phase2", outcome: "DEFERRED_TO_PHASE2", producer_ids: [], evidence: [] }
  : { id: check.id, applicability: "required", outcome: "PASS", producer_ids: [check.allowed_producers[0]], evidence: [{ path: `fixture/${check.id}`, sha256: "1".repeat(64) }] });
assert.equal(classifyPreTimingResult("current", preTimingChecks, { passed: true, findings: [] }), "pre_timing_passed");
assert.notEqual(classifyPreTimingResult("current", preTimingChecks, { passed: true, findings: [] }), "passed");
const promotedBeforeTiming = preTimingChecks.map((check) => check.id === "MC-08B" ? { ...check, applicability: "required", outcome: "PASS" } : check);
assert.throws(() => classifyPreTimingResult("current", promotedBeforeTiming, { passed: true, findings: [] }), /not exactly deferred/);
const forgedDeferral = preTimingChecks.map((check) => check.id === "MC-01A" ? { ...check, applicability: "deferred_to_phase2", outcome: "DEFERRED_TO_PHASE2", producer_ids: [], evidence: [] } : check);
assert.throws(() => classifyPreTimingResult("current", forgedDeferral, { passed: true, findings: [] }), /non-phase2 check cannot be deferred/);
const currentPhase2 = buildPhase2Correctness("current");
assert.doesNotThrow(() => validatePhase2Correctness(currentPhase2, "current"));
assert.throws(() => validatePhase2Correctness({ ...currentPhase2, checks: currentPhase2.checks.slice(1) }, "current"), /exact sealed current contract/);
assert.throws(() => validatePhase2Correctness({ ...currentPhase2, checks: currentPhase2.checks.map((check) => check.id === "MC-08B" ? { ...check, outcome: "FAIL" } : check) }, "current"), /exact sealed current contract/);
assert.throws(() => validatePhase2Correctness({ ...currentPhase2, checks: currentPhase2.checks.map((check) => check.id === "MC-08B" ? { ...check, id: "BND-02" } : check) }, "current"), /exact sealed current contract/);
assert.throws(() => validatePhase2Correctness({ ...currentPhase2, checks: currentPhase2.checks.map((check) => check.id === "MC-08B" ? { ...check, producer_id: "cms-lifecycle" } : check) }, "current"), /exact sealed current contract/);

const sourceRepo = join(temp, "producer-source-repo"); mkdirs(sourceRepo);
execFileSync("git", ["init", "--quiet"], { cwd: sourceRepo });
execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: sourceRepo });
execFileSync("git", ["config", "user.email", "phase2-selftest@example.invalid"], { cwd: sourceRepo });
execFileSync("git", ["config", "user.name", "Phase 2 self-test"], { cwd: sourceRepo });
for (const [index, path] of EXPECTED_PRODUCER_SOURCE_PATHS.entries()) {
  const absolute = join(sourceRepo, ...path.split("/")); mkdirs(resolve(absolute, "..")); writeFileSync(absolute, `reviewed producer source ${index}\n`);
}
execFileSync("git", ["add", "."], { cwd: sourceRepo });
execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: sourceRepo });
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRepo, encoding: "utf8" }).trim();
const exactSourceArchive = join(temp, "reviewed-producers.tar");
execFileSync("git", ["archive", "--format=tar", `--output=${exactSourceArchive}`, sourceRevision], { cwd: sourceRepo });
const exactSourceManifest = join(temp, "reviewed-producers.sha256");
const archivedSources = readGitArchive(exactSourceArchive);
writeFileSync(exactSourceManifest, `# schema_version=1\n# producer_source_archive_sha256=${sha256File(exactSourceArchive)}\n# producer_source_commit=${sourceRevision}\n${EXPECTED_PRODUCER_SOURCE_PATHS.map((path) => `${sha(archivedSources.files.get(path))}  ${path}`).join("\n")}\n`);
assert.equal(validateProducerFilesManifest(exactSourceManifest, exactSourceArchive).archiveRevision, sourceRevision);
const harnessFixturePaths = EXPECTED_PRODUCER_SOURCE_PATHS.filter((path) => path.startsWith("measurement/phase2/bin/") || ["docker-compose.yml", "Caddyfile.staging", "measurement/stack/docker-compose.measure.yml", "measurement/stack/measure-stack.sh"].includes(path));
const harnessFixtureManifest = join(temp, "live-harness.sha256");
const writeHarnessFixture = () => writeFileSync(harnessFixtureManifest, `${harnessFixturePaths.map((path) => `${sha256File(join(sourceRepo, ...path.split("/")))}  ${join(sourceRepo, ...path.split("/"))}`).join("\n")}\n`);
writeHarnessFixture();
assert.doesNotThrow(() => verifyHarnessAgainstProducerArchive({ harnessManifestPath: harnessFixtureManifest, producerManifestPath: exactSourceManifest, producerArchivePath: exactSourceArchive, producerCommit: sourceRevision, repoRoot: sourceRepo }));
writeFileSync(join(sourceRepo, "measurement", "phase2", "bin", "aggregate-pairs.mjs"), "modified after reviewed producer archive\n");
writeHarnessFixture();
assert.throws(() => verifyHarnessAgainstProducerArchive({ harnessManifestPath: harnessFixtureManifest, producerManifestPath: exactSourceManifest, producerArchivePath: exactSourceArchive, producerCommit: sourceRevision, repoRoot: sourceRepo }), /differ from the reviewed producer source archive/);
writeFileSync(exactSourceManifest, `${readFileSync(exactSourceManifest, "utf8")} ${"0".repeat(64)}  arbitrary.txt\n`);
assert.throws(() => validateProducerFilesManifest(exactSourceManifest, exactSourceArchive), /invalid producer-files|archive binding|source-path census/);

const producerImmutable = { run_id: "producer-fixture", side: "baseline", created_at: "2026-08-06T00:00:00.000Z" };
const producerArtifact = { path: "raw/route-manifests/evidence.json", sha256: "a".repeat(64), size_bytes: 1 };
const producerResult = {
  schema_version: 1, run_id: producerImmutable.run_id, producer_id: "route-manifests", side: "baseline",
  started_at: "2026-08-06T00:00:01.000Z", ended_at: "2026-08-06T00:00:02.000Z", exit_code: 0,
  cleanup: { status: "passed", evidence_paths: [producerArtifact.path] },
  observations: [{ check_id: "BND-01", outcome: "PASS", assertions: ["reviewed route manifest analysis passed"], evidence_paths: [producerArtifact.path] }],
  owned_artifacts: [producerArtifact],
};
assert.doesNotThrow(() => validateProducerResult(producerResult, { immutable: producerImmutable, producerId: "route-manifests" }));
assert.throws(() => validateProducerResult({ ...producerResult, producer_id: "generic-check" }, { immutable: producerImmutable, producerId: "generic-check" }), /outside the reviewed registry/);
assert.throws(() => validateProducerResult({ ...producerResult, observations: [{ ...producerResult.observations[0], check_id: "BND-02" }] }, { immutable: producerImmutable, producerId: "route-manifests" }), /producer observation is invalid/);
assert.throws(() => validateProducerResult({ ...producerResult, started_at: "2026-08-05T23:59:59.000Z" }, { immutable: producerImmutable, producerId: "route-manifests" }), /chronology/);

const routeRoot = join(temp, "route-contract"); const routeRaw = join(routeRoot, "raw", "cms-lifecycle"); mkdirs(routeRaw);
const routeImageId = `sha256:${"7".repeat(64)}`;
const routeFiles = new Map();
const writeRouteSample = (stem, cache, body = "stable response") => {
  const headersPath = `raw/cms-lifecycle/${stem}.headers`, bodyPath = `raw/cms-lifecycle/${stem}.body.html`;
  writeFileSync(join(routeRoot, ...headersPath.split("/")), `HTTP/1.1 200 OK\r\n${cache ? `X-Nextjs-Cache: ${cache}\r\n` : ""}ETag: \"stable\"\r\n\r\n`);
  writeFileSync(join(routeRoot, ...bodyPath.split("/")), body);
  routeFiles.set(headersPath, { path: headersPath, producer_id: "cms-lifecycle", check_ids: [] }); routeFiles.set(bodyPath, { path: bodyPath, producer_id: "cms-lifecycle", check_ids: [] });
};
writeRouteSample("binding-about-1", "MISS"); writeRouteSample("binding-about-2", "HIT");
for (const stem of ["binding-root", "binding-join", "binding-contact"]) writeRouteSample(stem, null, stem);
const stableBodySha = sha256File(join(routeRaw, "binding-about-2.body.html"));
const routeDocument = { schema_version: 1, side: "current", image_id: routeImageId, routes: {
  "/about": { samples: [{ phase: "miss", headers_path: "raw/cms-lifecycle/binding-about-1.headers", body_path: "raw/cms-lifecycle/binding-about-1.body.html" }, { phase: "hit", headers_path: "raw/cms-lifecycle/binding-about-2.headers", body_path: "raw/cms-lifecycle/binding-about-2.body.html" }], derived: { status: 200, next_cache: "HIT", etag: '"stable"', body_sha256: stableBodySha } },
  "/": { samples: [{ phase: "request", headers_path: "raw/cms-lifecycle/binding-root.headers", body_path: "raw/cms-lifecycle/binding-root.body.html" }], derived: { status: 200, next_cache: "ABSENT", etag: null, body_sha256: null } },
  "/join": { samples: [{ phase: "request", headers_path: "raw/cms-lifecycle/binding-join.headers", body_path: "raw/cms-lifecycle/binding-join.body.html" }], derived: { status: 200, next_cache: "ABSENT", etag: null, body_sha256: null } },
  "/contact": { samples: [{ phase: "request", headers_path: "raw/cms-lifecycle/binding-contact.headers", body_path: "raw/cms-lifecycle/binding-contact.body.html" }], derived: { status: 200, next_cache: "ABSENT", etag: null, body_sha256: null } },
} };
const routeEvidencePath = "raw/cms-lifecycle/route-response-evidence.json"; writeFileSync(join(routeRoot, ...routeEvidencePath.split("/")), `${JSON.stringify(routeDocument)}\n`);
routeFiles.set(routeEvidencePath, { path: routeEvidencePath, producer_id: "cms-lifecycle", check_ids: ["BND-02"] });
assert.deepEqual(verifyCorrectnessRouteEvidence(routeRoot, { side: "current", image: { id: routeImageId } }, routeFiles).routes, Object.fromEntries(Object.entries(routeDocument.routes).map(([route, value]) => [route, value.derived])));
writeFileSync(join(routeRaw, "binding-about-2.body.html"), "mutated response");
assert.throws(() => verifyCorrectnessRouteEvidence(routeRoot, { side: "current", image: { id: routeImageId } }, routeFiles), /stable MISS\/HIT pair/);

const stackRoot = join(temp, "stack-contract"); const stackFingerprint = "8".repeat(64); const postgresImage = `sha256:${"9".repeat(64)}`;
const writeStackStage = (stage, appContainerId) => {
  const directoryName = stage === "before" ? "inputs" : "postcondition-evidence"; const directory = join(stackRoot, directoryName); mkdirs(directory);
  const container = (service, containerId, selectedImage, containerPort, hostPort) => ({ schema_version: 1, service, container_id: containerId, image_id: selectedImage, compose_project: "tacbookings-measure", compose_service: service, network_mode: "tacbookings-measure_default", networks: { "tacbookings-measure_default": { NetworkID: "1".repeat(64), IPAddress: service === "app" ? "172.20.0.4" : "172.20.0.2" } }, ports: { [`${containerPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }] } });
  const leaves = {
    "app-container-inspect.json": container("app", appContainerId, routeImageId, 3000, 3003),
    "postgres-container-inspect.json": container("postgres", "2".repeat(64), postgresImage, 5432, 5435),
    "postgres-server-version.json": { schema_version: 1, version: "16.9", version_num: "160009", database: "tacbookings", user: "tac" },
    "database-fingerprint.json": { schema_version: 1, logical_fingerprint: stackFingerprint },
  };
  for (const [name, value] of Object.entries(leaves)) writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
  const bound = (name) => ({ path: `${directoryName}/${name}`, sha256: sha256File(join(directory, name)) });
  const aggregate = { schema_version: 1, stage, compose_project: "tacbookings-measure", image_id: routeImageId,
    app: { ...bound("app-container-inspect.json"), container_id: appContainerId },
    postgres: { ...bound("postgres-container-inspect.json"), container_id: "2".repeat(64), image_id: postgresImage },
    postgres_server: { ...bound("postgres-server-version.json"), version: "16.9", version_num: "160009", database: "tacbookings", user: "tac" },
    database: { ...bound("database-fingerprint.json"), logical_fingerprint: stackFingerprint }, verified: true, captured_at: stage === "before" ? "2026-08-06T00:00:00.000Z" : "2026-08-06T00:01:00.000Z" };
  const aggregateName = `stack-identity-${stage}.json`; writeFileSync(join(directory, aggregateName), `${JSON.stringify(aggregate)}\n`);
  return verifyStackIdentity(stackRoot, `${directoryName}/${aggregateName}`, { stage, imageId: routeImageId, composeProject: "tacbookings-measure", databaseFingerprint: stackFingerprint });
};
const stackBefore = writeStackStage("before", "3".repeat(64)); const stackAfter = writeStackStage("after", "4".repeat(64));
assert.equal(compareStackIdentities(stackBefore, stackAfter), true);
writeFileSync(join(stackRoot, "postcondition-evidence", "database-fingerprint.json"), '{"schema_version":1,"logical_fingerprint":"mutated"}\n');
assert.throws(() => verifyStackIdentity(stackRoot, "postcondition-evidence/stack-identity-after.json", { stage: "after", imageId: routeImageId, composeProject: "tacbookings-measure", databaseFingerprint: stackFingerprint }), /checksum/);

const runtimeIdentity = { schema_version: 1, app: { container_id: "a".repeat(64), image_id: `sha256:${"b".repeat(64)}` }, postgres: { container_id: "c".repeat(64), image_id: `sha256:${"d".repeat(64)}`, server_version: "16.9" }, verified: true };
const runtimePath = join(temp, "runtime-after.json"); writeFileSync(runtimePath, `${JSON.stringify(runtimeIdentity)}\n`);
const runtimeSha = sha256File(runtimePath);
assert.doesNotThrow(() => verifyPostFinalizationRuntimeIdentity(runtimePath, { claimedSha256: runtimeSha, expected: runtimeIdentity }));
assert.throws(() => verifyPostFinalizationRuntimeIdentity(runtimePath, { claimedSha256: "e".repeat(64), expected: runtimeIdentity }), /checksum/);
assert.throws(() => verifyPostFinalizationRuntimeIdentity(runtimePath, { claimedSha256: runtimeSha, expected: { ...runtimeIdentity, app: { ...runtimeIdentity.app, container_id: "f".repeat(64) } } }), /differs semantically/);

const aggregateSource = readFileSync(join(bin, "aggregate-pairs.mjs"), "utf8");
for (const contract of ["finalProfileExact", "observations.length === 4", "PRELIMINARY_ONLY", "OWNER_REVIEW_REQUIRED", "isFuturePathInside", "common_runtime_environment_hmac_sha256", "autonomous_progression_authorised: false"]) assert.match(aggregateSource, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const orchestrationSource = readFileSync(join(bin, "orchestrate-pairs.sh"), "utf8");
for (const contract of ["PAIR_COUNT:-4", "MAX_INTER_SIDE_GAP_SECONDS:-600", "MAX_INTER_PAIR_GAP_SECONDS:-600", "QUIET_MONITOR_INTERVAL_SECONDS:-10", "final-decision orchestration profile cannot weaken"]) assert.match(orchestrationSource, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

console.log("phase-2 self-test: all contract mutations were rejected");
