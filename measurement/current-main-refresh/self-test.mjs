import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MEASURE_CONTAINER_DEFINITIONS, validateMeasureContainer } from "./lib/measure-container-identity.mjs";
import { selectProducerSourceMembers } from "./lib/producer-source-set.mjs";
import { readGitTarArchive } from "./lib/git-tar.mjs";

const repo = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "issue-2352-correctness-self-test-"));
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const runIn = (cwd, command, args, expectedSuccess = true) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if ((result.status === 0) !== expectedSuccess) {
    throw new Error(`${command} ${args.join(" ")} ${expectedSuccess ? "failed" : "unexpectedly passed"}:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
};
const run = (command, args, expectedSuccess = true) => runIn(repo, command, args, expectedSuccess);
const bashPath = (path) => process.platform === "win32"
  ? path.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll("\\", "/")
  : path;
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const replaceOption = (args, name, value) => {
  const copy = [...args]; const index = copy.indexOf(name);
  if (index < 0 || index + 1 >= copy.length) throw new Error(`self-test option is missing: ${name}`);
  copy[index + 1] = value;
  return copy;
};
const rejectsFunction = (callback, label) => {
  try { callback(); } catch { return; }
  throw new Error(`${label} unexpectedly passed`);
};
const tarOctal = (value, length) => `${value.toString(8).padStart(length - 1, "0")}\0`;
const tarHeader = (path, size, type = "0") => {
  const header = Buffer.alloc(512);
  let name = path, prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const splits = [...name.matchAll(/\//g)].map((match) => match.index).filter((index) => Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100);
    const split = splits.at(-1); if (split === undefined) throw new Error(`tar fixture path is too long: ${path}`);
    prefix = name.slice(0, split); name = name.slice(split + 1);
  }
  header.write(name, 0); header.write(tarOctal(0o644, 8), 100); header.write(tarOctal(0, 8), 108); header.write(tarOctal(0, 8), 116);
  header.write(tarOctal(size, 12), 124); header.write(tarOctal(0, 12), 136); header.fill(0x20, 148, 156); header.write(type, 156);
  header.write("ustar\0", 257); header.write("00", 263); header.write(prefix, 345);
  const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
};
const paxRecord = (key, value) => {
  const body = `${key}=${value}\n`; let length = Buffer.byteLength(body) + 3;
  while (Buffer.byteLength(`${length} ${body}`) !== length) length = Buffer.byteLength(`${length} ${body}`);
  return `${length} ${body}`;
};
const writeProducerArchiveFixture = (path, revision) => {
  const paths = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute); else if (entry.isFile()) paths.push(absolute); else throw new Error("producer fixture contains a special file");
    }
  };
  walk(resolve(repo, "measurement/current-main-refresh"));
  walk(resolve(repo, "measurement/phase2"));
  paths.push(
    resolve(repo, "Caddyfile.staging"),
    resolve(repo, "docker-compose.yml"),
    resolve(repo, "measurement/stack/measure-stack.sh"),
    resolve(repo, "measurement/stack/docker-compose.measure.yml"),
  );
  const chunks = [];
  const global = Buffer.from(paxRecord("comment", revision));
  chunks.push(tarHeader("pax_global_header", global.length, "g"), global, Buffer.alloc((512 - global.length % 512) % 512));
  for (const absolute of paths.sort()) {
    const bytes = readFileSync(absolute); const relative = absolute.slice(repo.length + 1).replaceAll("\\", "/");
    chunks.push(tarHeader(relative, bytes.length), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024)); writeFileSync(path, Buffer.concat(chunks));
};

try {
  const censusPath = resolve(import.meta.dirname, "check-census.json");
  const census = JSON.parse(readFileSync(censusPath, "utf8"));
  const expectedIds = [
    "MC-01A","MC-01B","MC-02","MC-03A","MC-03B","MC-03C","MC-03D","MC-04A","MC-04B","MC-04C","MC-04D",
    "MC-05","MC-06","MC-07","MC-08A","MC-08B","MC-09","MC-10","MC-11A","MC-11B","MC-11C","MC-11D","MC-11E",
    "BND-01","BND-02","BND-03","BND-04","BND-05","BND-06","BND-07","BND-08","BND-09","BND-10","BND-11","BND-12",
  ];
  if (JSON.stringify(census.checks.map((check) => check.id)) !== JSON.stringify(expectedIds)) throw new Error("35-check census drifted");
  if (census.checks.some((check) => check.required_sides.length === 0 || check.allowed_producers.length === 0)) throw new Error("census has an unbound check");

  const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const sourceArchive = join(temp, "source.tar");
  run("git", ["archive", "--format=tar", `--output=${sourceArchive}`, head]);
  const producerCommit = "d".repeat(40);
  const producerArchive = join(temp, "producer-source.tar");
  writeProducerArchiveFixture(producerArchive, producerCommit);
  rejectsFunction(() => selectProducerSourceMembers({ members: new Map([["measurement/phase2/.env.measure", { sha256: "0".repeat(64) }]]) }), "producer archive environment file");
  const archivedCheckCensus = join(temp, "archived-check-census.json");
  const archivedWriterCensus = join(temp, "archived-public-writer-census.json");
  run(process.execPath, ["measurement/current-main-refresh/bin/extract-archive-member.mjs", "--archive", producerArchive, "--commit", producerCommit, "--member", "measurement/current-main-refresh/check-census.json", "--out", archivedCheckCensus]);
  run(process.execPath, ["measurement/current-main-refresh/bin/extract-archive-member.mjs", "--archive", producerArchive, "--commit", producerCommit, "--member", "measurement/current-main-refresh/public-writer-census.json", "--out", archivedWriterCensus]);

  const authStateFixture = join(temp, "admin-state.json");
  json(authStateFixture, { cookies: [{ name: "authjs.session-token", value: "fixture", domain: "127.0.0.1", path: "/" }], origins: [] });
  const safetyArgs = [
    "measurement/current-main-refresh/bin/validate-orchestrator-inputs.mjs",
    "--compose-project", "tacbookings-measure", "--app-container", "tacbookings-measure-app-1",
    "--postgres-container", "tacbookings-measure-postgres-1", "--base-url", "http://127.0.0.1:8027",
    "--mailpit-url", "http://127.0.0.1:8127", "--auth-state", authStateFixture,
  ];
  run(process.execPath, safetyArgs);
  run(process.execPath, replaceOption(safetyArgs, "--compose-project", "tacbookings-staging"), false);
  run(process.execPath, replaceOption(safetyArgs, "--app-container", "tacbookings-staging-app-1"), false);
  run(process.execPath, replaceOption(safetyArgs, "--base-url", "https://staging.example.invalid"), false);
  run(process.execPath, replaceOption(safetyArgs, "--mailpit-url", "http://127.0.0.1:8025"), false);
  const externalAuthState = join(temp, "external-admin-state.json");
  json(externalAuthState, { cookies: [{ name: "authjs.session-token", value: "fixture", domain: ".example.invalid", path: "/" }], origins: [] });
  run(process.execPath, replaceOption(safetyArgs, "--auth-state", externalAuthState), false);
  const runnerSource = readFileSync(resolve(import.meta.dirname, "run-correctness-producers.sh"), "utf8");
  if (runnerSource.indexOf("validate-orchestrator-inputs.mjs") < 0 || runnerSource.indexOf("validate-orchestrator-inputs.mjs") > runnerSource.indexOf("resolve-measure-container.mjs")) {
    throw new Error("orchestrator safety arguments are not rejected before the first Docker-backed identity resolution");
  }
  if (!runnerSource.includes("bfe53aeab6dd54ed5bfcf3636a1643451f277bef") || !runnerSource.includes("f442e389e0e5d4c2e18fa330b2fb155550b12871") || !runnerSource.includes("producer and application source authorities must be distinct")) {
    throw new Error("orchestrator does not pin distinct approved application and producer source authorities");
  }
  if (!/runtime-provenance\.mjs"? --root/.test(runnerSource) || runnerSource.search(/runtime-provenance\.mjs"? --root/) > runnerSource.indexOf("docker exec")) {
    throw new Error("ignored runtime dependencies are not captured before the first Docker mutation");
  }
  const runProducerBody = /run_producer\(\) \{([\s\S]*?)\n\}/.exec(runnerSource)?.[1] ?? "";
  if ((runProducerBody.match(/producer_source_guard_verify/g) ?? []).length !== 2 || !runnerSource.includes("PRODUCER_SOURCE_GUARD_MANIFEST") || !runnerSource.includes("FROZEN_PRODUCER_ROOT")) {
    throw new Error("orchestrator does not verify frozen producer bytes before and after every producer");
  }
  const postconditionsWrite = runnerSource.indexOf('"$RUN_ROOT/postconditions.json"');
  if (postconditionsWrite < 0 || runnerSource.lastIndexOf("producer_source_guard_verify", postconditionsWrite) < runnerSource.indexOf("RESTORED_DATABASE_FINGERPRINT") || runnerSource.indexOf("producer_source_guard_final_check", postconditionsWrite) < postconditionsWrite) {
    throw new Error("orchestrator does not guard postcondition evidence before and after emission");
  }
  const producerLibrarySource = readFileSync(resolve(import.meta.dirname, "lib/producer.sh"), "utf8");
  if (!producerLibrarySource.includes("sha256sum --check --strict --status") || !producerLibrarySource.includes("--verify-live-root")) throw new Error("producer guard lacks independent and semantic source verification");
  const browserSource = readFileSync(resolve(import.meta.dirname, "bin/run-browser-suite.mjs"), "utf8");
  if (browserSource.indexOf("validateLocalAuthState") > browserSource.indexOf("chromium.launch()") || browserSource.indexOf("context.route") < 0 || !/serviceWorkers:\s*["']block["']/.test(browserSource) || (browserSource.match(/browser\.newContext/g) ?? []).length !== 1) {
    throw new Error("browser credentials are not validated and request-confined with service workers blocked before navigation");
  }

  const networkId = "3".repeat(64);
  const networkFixture = { Id: networkId, Labels: { "com.docker.compose.project": "tacbookings-measure" } };
  const containerFixture = (service) => {
    const definition = MEASURE_CONTAINER_DEFINITIONS[service];
    return {
      Id: service === "app" ? "1".repeat(64) : "2".repeat(64), Name: `/${definition.name}`,
      Image: service === "app" ? `sha256:${"a".repeat(64)}` : `sha256:${"b".repeat(64)}`,
      State: { Running: true },
      Config: { Image: definition.configImage ?? "fixture@sha256:app", Labels: { "com.docker.compose.project": "tacbookings-measure", "com.docker.compose.service": service } },
      HostConfig: { NetworkMode: "tacbookings-measure_default", Memory: definition.memory, NanoCpus: definition.nanoCpus },
      NetworkSettings: { Networks: { tacbookings_measure_placeholder: {} }, Ports: { [definition.containerPort]: [{ HostIp: "127.0.0.1", HostPort: definition.hostPort }] } },
    };
  };
  for (const service of Object.keys(MEASURE_CONTAINER_DEFINITIONS)) {
    const fixture = containerFixture(service);
    fixture.NetworkSettings.Networks = { "tacbookings-measure_default": { NetworkID: networkId } };
    validateMeasureContainer(service, fixture, networkFixture, service === "app" ? fixture.Image : null);
  }
  const stagingContainer = containerFixture("postgres");
  stagingContainer.NetworkSettings.Networks = { "tacbookings-measure_default": { NetworkID: networkId } };
  stagingContainer.Config.Labels["com.docker.compose.project"] = "tacbookings-staging";
  rejectsFunction(() => validateMeasureContainer("postgres", stagingContainer, networkFixture), "staging Postgres identity");
  const externalBinding = containerFixture("caddy");
  externalBinding.NetworkSettings.Networks = { "tacbookings-measure_default": { NetworkID: networkId } };
  externalBinding.NetworkSettings.Ports["8027/tcp"][0].HostIp = "0.0.0.0";
  rejectsFunction(() => validateMeasureContainer("caddy", externalBinding, networkFixture), "non-loopback Caddy binding");

  const cleanupHarness = join(temp, "cleanup-harness.sh");
  writeFileSync(cleanupHarness, `#!/usr/bin/env bash
set -euo pipefail
source measurement/current-main-refresh/lib/producer.sh
CLEANUP_INVOKED=false
EVIDENCE="$1"
MARKER="$2"
MODE="$3"
cleanup() {
  set +e
  printf '{"status":"failed"}\\n' > "$EVIDENCE"
  [[ "$MODE" == return-zero ]] && return 0
  return 7
}
producer_complete_cleanup cleanup "$EVIDENCE"
printf reached > "$MARKER"
`);
  for (const mode of ["return-seven", "return-zero"]) {
    const cleanupEvidence = join(temp, `${mode}-cleanup.json`), escapedMarker = join(temp, `${mode}-escaped.txt`);
    run("bash", [bashPath(cleanupHarness), bashPath(cleanupEvidence), bashPath(escapedMarker), mode], false);
    if (existsSync(escapedMarker)) throw new Error(`${mode} cleanup failure escaped into producer result construction`);
  }
  const cleanupCallSources = readdirSync(import.meta.dirname, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sh"))
    .map((entry) => readFileSync(resolve(import.meta.dirname, entry.name), "utf8")).join("\n");
  if (/CLEANUP_INVOKED=true\s*;?\s*cleanup(?:\s|;)/.test(cleanupCallSources)) throw new Error("a producer bypasses producer_complete_cleanup on its success path");
  const browserShell = readFileSync(resolve(import.meta.dirname, "run-browser-suite.sh"), "utf8");
  if ((browserShell.match(/runtime-provenance\.mjs --root "\$PWD" --verify/g) ?? []).length !== 2) throw new Error("browser runtime provenance is not verified immediately before and after use");
  if (/if \[\[ "\$app_count" == 1 && "\$token_count" == 2/.test(browserShell) || !/DELETE FROM \\\"MemberApplication\\\" WHERE \\\"applicantEmail\\\"/.test(browserShell)) {
    throw new Error("browser cleanup does not delete exact-email partial applications independently of expected token shape");
  }

  const sourceCensusOut = join(temp, "source-census.json");
  run(process.execPath, [
    "measurement/current-main-refresh/bin/generate-source-census.mjs",
    "--expected", archivedWriterCensus, "--app-source-archive", sourceArchive, "--app-source-commit", head, "--out", sourceCensusOut,
  ]);
  const sourceCensus = JSON.parse(readFileSync(sourceCensusOut, "utf8"));
  if (sourceCensus.writer_count !== 39 || !sourceCensus.structural_census_complete || !sourceCensus.canonical_invalidation_complete || !sourceCensus.archive_membership_complete || sourceCensus.runtime_exhaustive || sourceCensus.focused_contract_evidence.length !== 6) {
    throw new Error("writer census did not preserve complete structural proof and honest representative-runtime labelling");
  }
  if (sourceCensus.cms_page_content_endpoint.delete_endpoint_present !== false || sourceCensus.cms_page_content_endpoint.disposition !== "OWNER_DISPOSITION_NEEDED") {
    throw new Error("CMS delete applicability did not remain blocked");
  }

  const makeRun = (name) => {
    const root = join(temp, name);
    mkdirSync(join(root, "raw", "source-census"), { recursive: true });
    mkdirSync(join(root, "producer-results"));
    writeFileSync(join(root, "raw", "source-census", "evidence.txt"), "evidence\n");
    writeFileSync(join(root, "raw", "source-census", "cleanup.json"), "{}\n");
    return root;
  };
  const writerArgs = (root, observations, out = join(root, "producer-results", "source-census.json")) => {
    const observationsPath = join(root, "raw", "source-census", "observations.json");
    json(observationsPath, observations);
    return [
      "measurement/current-main-refresh/lib/write-producer-result.mjs",
      "--run-root", root, "--run-id", "self-test", "--producer-id", "source-census", "--side", "current",
      "--started-at", "2026-08-06T00:00:00.000Z", "--ended-at", "2026-08-06T00:00:01.000Z", "--exit-code", "0",
      "--observations", observationsPath, "--cleanup-evidence", "raw/source-census/cleanup.json", "--census", censusPath, "--out", out,
    ];
  };
  const validObservation = [{
    check_id: "MC-03D", outcome: "OWNER_DISPOSITION_NEEDED", assertions: ["page-content has no DELETE export"],
    evidence_paths: ["raw/source-census/evidence.txt"],
  }];
  const positiveRoot = makeRun("writer-positive");
  run(process.execPath, writerArgs(positiveRoot, validObservation));
  const producerResult = JSON.parse(readFileSync(join(positiveRoot, "producer-results", "source-census.json"), "utf8"));
  if (producerResult.cleanup.status !== "passed" || producerResult.observations[0].outcome !== "OWNER_DISPOSITION_NEEDED") throw new Error("producer result normalization failed");
  if (!Array.isArray(producerResult.owned_artifacts) || producerResult.owned_artifacts.length !== 3 || producerResult.owned_artifacts.some((row) => !row.path.startsWith("raw/source-census/") || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size_bytes))) {
    throw new Error("producer result did not enumerate exact owned raw artifacts");
  }
  run(process.execPath, writerArgs(makeRun("writer-bad-outcome"), [{ ...validObservation[0], outcome: "NOT_APPLICABLE" }]), false);
  run(process.execPath, writerArgs(makeRun("writer-escape"), [{ ...validObservation[0], evidence_paths: ["../escape.txt"] }]), false);
  const wrongOutRoot = makeRun("writer-wrong-out");
  run(process.execPath, writerArgs(wrongOutRoot, validObservation, join(wrongOutRoot, "wrong.json")), false);

  const appPaths = Object.fromEntries(["/","/[...slug]","/join","/contact","/join/apply","/hut-leader-instructions","/join/[code]","/join/verify/[token]"].map((route) => [`source:${route}`, route]));
  const routes = { staticRoutes: [], dynamicRoutes: [] };
  for (const side of ["current", "baseline"]) {
    const fixture = join(temp, `route-${side}`); mkdirSync(fixture);
    json(join(fixture, "app.json"), appPaths);
    json(join(fixture, "prerender.json"), { routes: {}, dynamicRoutes: side === "current" ? { "/[...slug]": {} } : {} });
    json(join(fixture, "routes.json"), routes);
    run(process.execPath, [
      "measurement/current-main-refresh/bin/analyse-route-manifests.mjs", "--side", side,
      "--app-paths", join(fixture, "app.json"), "--prerender", join(fixture, "prerender.json"),
      "--routes", join(fixture, "routes.json"), "--out", join(fixture, "analysis.json"),
    ]);
  }

  const stored = join(temp, "stored-404"); mkdirSync(stored);
  const policy = (nonce) => `HTTP/1.1 404 Not Found\r\nContent-Security-Policy: default-src 'self'; script-src 'nonce-${nonce}'\r\n\r\n`;
  const body = (nonce) => `<html><body><script nonce="${nonce}"></script></body></html>`;
  for (const [name, value] of [
    ["first.headers", policy("aaa")], ["second.headers", policy("bbb")], ["cleared.headers", policy("ccc")],
    ["first.body", body("aaa")], ["second.body", body("aaa")], ["cleared.body", body("ccc")],
    ["first.status", "404\n"], ["second.status", "404\n"], ["cleared.status", "404\n"],
  ]) writeFileSync(join(stored, name), value);
  json(join(stored, "browser.json"), { schema_version: 1, status: 404, visible_text: "", visible_character_count: 0 });
  run(process.execPath, [
    "measurement/current-main-refresh/bin/analyse-stored-404.mjs",
    "--first-headers", join(stored, "first.headers"), "--first-body", join(stored, "first.body"), "--first-status", join(stored, "first.status"),
    "--second-headers", join(stored, "second.headers"), "--second-body", join(stored, "second.body"), "--second-status", join(stored, "second.status"),
    "--cleared-headers", join(stored, "cleared.headers"), "--cleared-body", join(stored, "cleared.body"), "--cleared-status", join(stored, "cleared.status"),
    "--browser", join(stored, "browser.json"), "--out", join(stored, "analysis.json"),
  ]);

  const routeEvidenceRun = join(temp, "route-evidence-run");
  const routeEvidenceRaw = join(routeEvidenceRun, "raw", "cms-lifecycle");
  mkdirSync(routeEvidenceRaw, { recursive: true });
  const writeResponse = (prefix, cache, etag, bodyText = "<html>fixture</html>") => {
    const fields = ["HTTP/1.1 200 OK", ...(cache ? [`x-nextjs-cache: ${cache}`] : []), ...(etag ? [`etag: ${etag}`] : [])];
    writeFileSync(join(routeEvidenceRaw, `${prefix}.headers`), `${fields.join("\r\n")}\r\n\r\n`);
    writeFileSync(join(routeEvidenceRaw, `${prefix}.body.html`), bodyText);
  };
  writeResponse("binding-about-1", "MISS", '"fixture"');
  writeResponse("binding-about-2", "HIT", '"fixture"');
  for (const prefix of ["binding-root", "binding-join", "binding-contact"]) writeResponse(prefix, null, null);
  const routeEvidenceOut = join(routeEvidenceRaw, "route-response-evidence.json");
  run(process.execPath, [
    "measurement/current-main-refresh/bin/build-route-response-evidence.mjs", "--run-root", routeEvidenceRun,
    "--raw", routeEvidenceRaw, "--side", "current", "--image-id", `sha256:${"d".repeat(64)}`, "--out", routeEvidenceOut,
  ]);
  const routeEvidence = JSON.parse(readFileSync(routeEvidenceOut, "utf8"));
  if (Object.keys(routeEvidence.routes).join(",") !== "/about,/,/join,/contact" || routeEvidence.routes["/about"].derived.next_cache !== "HIT" || routeEvidence.routes["/"].derived.next_cache !== "ABSENT") {
    throw new Error("typed route response evidence drifted");
  }
  writeFileSync(join(routeEvidenceRaw, "binding-about-2.headers"), 'HTTP/1.1 200 OK\r\nx-nextjs-cache: HIT\r\nx-nextjs-cache: HIT\r\netag: "fixture"\r\n\r\n');
  run(process.execPath, [
    "measurement/current-main-refresh/bin/build-route-response-evidence.mjs", "--run-root", routeEvidenceRun,
    "--raw", routeEvidenceRaw, "--side", "current", "--image-id", `sha256:${"d".repeat(64)}`, "--out", join(routeEvidenceRaw, "duplicate-rejected.json"),
  ], false);

  const logRun = join(temp, "log-run");
  const logOwners = ["cache-fault","cms-lifecycle","browser-suite","wire-security","stored-404","public-layout-writers","setup-transition","revalidation-300s","warm-db","adult-hosting","deploy-warmup"];
  const logPaths = logOwners.map((owner) => {
    const directory = join(logRun, "raw", owner); mkdirSync(directory, { recursive: true });
    const path = join(directory, "app-scenario.log");
    writeFileSync(path, owner === "cache-fault" ? "Error: ENOSPC no space left on device\n" : "request complete\n");
    return path;
  });
  run(process.execPath, ["measurement/current-main-refresh/bin/analyse-log-noise.mjs", "--out", join(logRun, "analysis.json"), "--logs", ...logPaths]);
  writeFileSync(logPaths.at(-1), "warning: repeated fixture 42\nwarning: repeated fixture 43\nwarning: repeated fixture 44\n");
  run(process.execPath, ["measurement/current-main-refresh/bin/analyse-log-noise.mjs", "--out", join(logRun, "repeated.json"), "--logs", ...logPaths], false);

  const canonicalContractOut = join(temp, "canonical-contract.json");
  run(process.execPath, ["measurement/current-main-refresh/bin/build-canonical-contract.mjs", "--app-source-archive", sourceArchive, "--app-source-commit", head, "--out", canonicalContractOut]);
  const canonicalContract = JSON.parse(readFileSync(canonicalContractOut, "utf8"));
  if (canonicalContract.routes.length !== 5 || canonicalContract.routes.some((row) => row.expectation.kind !== "absent" || row.expectation.count !== 0 || row.source_paths.length !== 2)) {
    throw new Error("source-derived canonical metadata contract drifted");
  }

  const producerManifest = join(temp, "producer-files.sha256");
  run(process.execPath, ["measurement/current-main-refresh/bin/build-producer-manifest.mjs", "--producer-source-archive", producerArchive, "--producer-source-commit", producerCommit, "--out", producerManifest]);
  const manifestText = readFileSync(producerManifest, "utf8");
  const manifestPaths = manifestText.trimEnd().split(/\r?\n/).slice(3).map((line) => line.slice(66));
  const rawOrderedPaths = [...manifestPaths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (JSON.stringify(manifestPaths) !== JSON.stringify(rawOrderedPaths)) throw new Error("producer manifest is not raw-code-unit ordered");
  for (const path of ["self-test.mjs", "run-correctness-producers.sh", "run-stored-404.sh", "run-deploy-warmup.sh", "run-setup-transition.sh", "bin/scan-image-build.mjs", "bin/build-canonical-contract.mjs", "measurement/phase2/README.md", "measurement/phase2/bin/run-phase2.sh", "measurement/phase2/test-fixtures/wrong-cache.headers", "docker-compose.yml", "Caddyfile.staging", "measurement/stack/measure-stack.sh"]) {
    if (!manifestText.includes(path)) throw new Error(`producer manifest omitted ${path}`);
  }
  const liveProducerRoot = join(temp, "live-producer-root");
  mkdirSync(liveProducerRoot);
  for (const [memberPath, member] of readGitTarArchive(producerArchive, producerCommit).members) {
    const target = join(liveProducerRoot, ...memberPath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, member.bytes);
  }
  const producerVerifier = resolve(repo, "measurement/current-main-refresh/bin/build-producer-manifest.mjs");
  const verifyLiveArgs = [producerVerifier, "--producer-source-archive", producerArchive, "--producer-source-commit", producerCommit, "--verify-live-root", liveProducerRoot];
  run(process.execPath, verifyLiveArgs);
  const guardHarness = join(temp, "producer-source-guard-harness.sh");
  writeFileSync(guardHarness, `#!/usr/bin/env bash
set -euo pipefail
source "$1"
export PRODUCER_SOURCE_GUARD_TOOL="$2"
export PRODUCER_SOURCE_GUARD_MANIFEST="$3"
export PRODUCER_SOURCE_GUARD_ARCHIVE="$4"
export PRODUCER_SOURCE_GUARD_COMMIT="$5"
export PRODUCER_SOURCE_GUARD_LIVE_ROOT="$6"
export PRODUCER_SOURCE_GUARD_RUN_ROOT="$7"
export PRODUCER_SOURCE_GUARD_NODE="$9"
if [[ "$8" == verify ]]; then producer_source_guard_verify; else producer_source_guard_final_check; fi
`);
  const guardNodeWrapper = join(temp, "producer-source-node-wrapper.sh");
  writeFileSync(guardNodeWrapper, `#!/usr/bin/env bash
set -euo pipefail
node_executable=${JSON.stringify(bashPath(process.execPath))}
converted=()
for value in "$@"; do
  if [[ "$value" == /mnt/* ]]; then converted+=("$(wslpath -w "$value")"); else converted+=("$value"); fi
done
exec "$node_executable" "${'${converted[@]}'}"
`);
  chmodSync(guardNodeWrapper, 0o755);
  const handoffRun = join(temp, "source-guard-handoff");
  mkdirSync(join(handoffRun, "postcondition-evidence"), { recursive: true });
  mkdirSync(join(handoffRun, "raw", "orchestrator"), { recursive: true });
  for (const path of ["postconditions.json", "COMPLETED.json", "postcondition-evidence/stack.json", "raw/orchestrator/app-health.json"]) writeFileSync(join(handoffRun, ...path.split("/")), "{}\n");
  const guardArgs = [
    guardHarness, resolve(repo, "measurement/current-main-refresh/lib/producer.sh"), producerVerifier, producerManifest,
    producerArchive, producerCommit, liveProducerRoot, handoffRun,
  ].map(bashPath);
  run("bash", [...guardArgs, "verify", bashPath(guardNodeWrapper)]);
  const tamperedVerifier = join(liveProducerRoot, "measurement/current-main-refresh/bin/build-producer-manifest.mjs");
  writeFileSync(tamperedVerifier, `${readFileSync(tamperedVerifier, "utf8")}\n// changed after initial source acceptance\n`);
  run(process.execPath, verifyLiveArgs, false);
  run("bash", [...guardArgs, "final", bashPath(guardNodeWrapper)], false);
  for (const path of ["postconditions.json", "COMPLETED.json", "postcondition-evidence", "raw/orchestrator"]) {
    if (existsSync(join(handoffRun, ...path.split("/")))) throw new Error(`source mutation left handoff evidence behind: ${path}`);
  }

  const databaseArchive = join(temp, "database.dump"); writeFileSync(databaseArchive, "canonical database fixture\n");
  const imageId = `sha256:${"a".repeat(64)}`;
  const imageInspect = join(temp, "image-inspect.json"); json(imageInspect, { id: imageId, oci_revision: head });
  const containerInspect = join(temp, "container-inspect.json"); json(containerInspect, { id: "container", image_id: imageId, compose_project: "tacbookings-measure", compose_service: "app" });
  const censusCopy = join(temp, "check-census.json"); cpSync(archivedCheckCensus, censusCopy);
  const writerCensusCopy = join(temp, "public-writer-census.json"); cpSync(archivedWriterCensus, writerCensusCopy);
  const imageEvidenceRun = join(temp, "image-evidence-run"); mkdirSync(join(imageEvidenceRun, "inputs"), { recursive: true });
  const imageBuildRaw = join(imageEvidenceRun, "inputs", "image-build-scan.raw.json");
  json(imageBuildRaw, {
    schema_version: 1, image_id: imageId, oci_revision: head,
    scanned_roots: ["/app/.next/server", "/app/.next/static"], scanned_file_count: 2, scanned_bytes: 100,
    filesystem_aggregate_sha256: "e".repeat(64), public_sentry_dsn_literal_count: 0, public_sentry_identifier_count: 1,
    locations: [{ path: "/app/.next/server/app.js", sha256: "f".repeat(64), dsn_literal_count: 0, public_identifier_count: 1 }],
  });
  const imageBuildRuntime = join(imageEvidenceRun, "inputs", "image-build-runtime-env.json");
  json(imageBuildRuntime, { schema_version: 1, image_id: imageId, present: true, blank: true });
  const imageBuildEvidence = join(imageEvidenceRun, "inputs", "image-build-identity.json");
  run(process.execPath, [
    "measurement/current-main-refresh/bin/validate-image-build-scan.mjs", "--run-root", imageEvidenceRun,
    "--image-id", imageId, "--oci-revision", head, "--raw", imageBuildRaw, "--runtime-env", imageBuildRuntime, "--out", imageBuildEvidence,
  ]);
  const unsafeBuildRaw = join(imageEvidenceRun, "inputs", "unsafe-image-build-scan.raw.json");
  json(unsafeBuildRaw, { ...JSON.parse(readFileSync(imageBuildRaw, "utf8")), public_sentry_dsn_literal_count: 1 });
  run(process.execPath, [
    "measurement/current-main-refresh/bin/validate-image-build-scan.mjs", "--run-root", imageEvidenceRun,
    "--image-id", imageId, "--oci-revision", head, "--raw", unsafeBuildRaw, "--runtime-env", imageBuildRuntime, "--out", join(imageEvidenceRun, "inputs", "unsafe-identity.json"),
  ], false);
  const runtimeRoot = join(temp, "runtime-root");
  const runtimeNodeModules = join(runtimeRoot, "node_modules");
  mkdirSync(runtimeNodeModules, { recursive: true });
  const runtimePackageVersions = { "@playwright/test": "1.62.0", playwright: "1.62.0", "playwright-core": "1.62.0", "axe-core": "4.12.1" };
  const runtimeLockPackages = { "": { name: "runtime-fixture", version: "1.0.0" } };
  json(join(runtimeRoot, "package.json"), { name: "runtime-fixture", version: "1.0.0", engines: { node: ">=24.0.0 <25" } });
  for (const [name, version] of Object.entries(runtimePackageVersions)) {
    const packageRoot = join(runtimeNodeModules, ...name.split("/"));
    mkdirSync(packageRoot, { recursive: true });
    json(join(packageRoot, "package.json"), { name, version, ...(name === "playwright" ? { main: "index.js" } : {}) });
    runtimeLockPackages[`node_modules/${name}`] = { version, integrity: "sha512-Zml4dHVyZQ==" };
  }
  json(join(runtimeRoot, "package-lock.json"), { name: "runtime-fixture", version: "1.0.0", lockfileVersion: 3, packages: runtimeLockPackages });
  json(join(runtimeNodeModules, ".package-lock.json"), { name: "runtime-fixture", version: "1.0.0", lockfileVersion: 3, packages: runtimeLockPackages });
  const fixtureChromium = join(runtimeRoot, "chromium-fixture.exe");
  writeFileSync(fixtureChromium, "fixture Chromium executable\n");
  json(join(runtimeNodeModules, "playwright-core", "browsers.json"), { browsers: [{ name: "chromium", revision: "1194", browserVersion: "140.0.7339.16" }] });
  writeFileSync(join(runtimeNodeModules, "playwright", "index.js"), `exports.chromium = { executablePath: () => ${JSON.stringify(fixtureChromium)} };\n`);
  const runtimeRegistryDirectory = join(runtimeNodeModules, "playwright-core", "lib", "server", "registry");
  mkdirSync(runtimeRegistryDirectory, { recursive: true });
  writeFileSync(join(runtimeRegistryDirectory, "index.js"), `exports.registry = { findExecutable: (name) => name === "chromium" ? { executablePath: () => ${JSON.stringify(fixtureChromium)} } : undefined };\n`);
  const runtimeTool = resolve(repo, "measurement/current-main-refresh/bin/runtime-provenance.mjs");
  const runtimeProvenance = join(temp, "runtime-provenance.json");
  runIn(runtimeRoot, process.execPath, [runtimeTool, "--root", runtimeRoot, "--out", runtimeProvenance]);
  runIn(runtimeRoot, process.execPath, [runtimeTool, "--root", runtimeRoot, "--verify", runtimeProvenance]);
  runIn(runtimeRoot, process.execPath, [runtimeTool, "--root", temp, "--out", join(temp, "external-runtime.json")], false);
  const runtimeDocument = JSON.parse(readFileSync(runtimeProvenance, "utf8"));
  const expectedPhysicalNode = realpathSync.native(process.execPath);
  const sameNodePath = process.platform === "win32"
    ? runtimeDocument.node.executable.path.toLowerCase() === expectedPhysicalNode.toLowerCase()
    : runtimeDocument.node.executable.path === expectedPhysicalNode;
  if (!sameNodePath) throw new Error("runtime provenance did not bind the physical Node executable behind the fnm alias");
  const rejectRuntimeMutation = (name, mutate) => {
    const mutated = structuredClone(runtimeDocument); mutate(mutated);
    const path = join(temp, `${name}-runtime-provenance.json`); json(path, mutated);
    runIn(runtimeRoot, process.execPath, [runtimeTool, "--root", runtimeRoot, "--verify", path], false);
  };
  rejectRuntimeMutation("external-root-package", (value) => { value.root_package.path = join(temp, "external", "package.json"); });
  rejectRuntimeMutation("nested-package", (value) => { value.packages.playwright.package_json_path = join(runtimeRoot, "node_modules", "playwright", "node_modules", "playwright", "package.json"); });
  rejectRuntimeMutation("wrong-node", (value) => { value.node.executable.path = join(runtimeRoot, "alternate-node.exe"); });
  rejectRuntimeMutation("wrong-chromium", (value) => { value.chromium.executable.path = join(runtimeRoot, "alternate-chromium.exe"); });
  rejectRuntimeMutation("wrong-registry", (value) => { value.chromium.registry.path = join(runtimeRoot, "node_modules", "playwright", "browsers.json"); });

  const identityRun = join(temp, "identity-run"); const identityInputs = join(identityRun, "inputs"); mkdirSync(identityInputs, { recursive: true });
  const network = "tacbookings-measure_default";
  const inspectFixture = (service, serviceImage, port, hostPort) => ({
    schema_version: 1, service, container_id: service === "app" ? "1".repeat(64) : "2".repeat(64), image_id: serviceImage,
    compose_project: "tacbookings-measure", compose_service: service, network_mode: network,
    networks: { [network]: { NetworkID: "3".repeat(64), IPAddress: service === "app" ? "172.30.0.4" : "172.30.0.2" } },
    ports: { [`${port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }] },
  });
  const stackApp = join(identityInputs, "app-container-inspect.json"); json(stackApp, inspectFixture("app", imageId, 3000, 3003));
  const stackPostgres = join(identityInputs, "postgres-container-inspect.json"); json(stackPostgres, inspectFixture("postgres", `sha256:${"9".repeat(64)}`, 5432, 5435));
  const stackServer = join(identityInputs, "postgres-server-version.json"); json(stackServer, { schema_version: 1, version: "17.5", version_num: "170005", database: "tacbookings", user: "tac" });
  const stackDatabase = join(identityInputs, "database-fingerprint.json"); json(stackDatabase, { schema_version: 1, logical_fingerprint: "b".repeat(64) });
  const stackIdentityBefore = join(identityInputs, "stack-identity-before.json");
  run(process.execPath, [
    "measurement/current-main-refresh/bin/build-stack-identity.mjs", "--run-root", identityRun, "--stage", "before",
    "--compose-project", "tacbookings-measure", "--image-id", imageId, "--database-fingerprint", "b".repeat(64),
    "--app", stackApp, "--postgres", stackPostgres, "--postgres-server", stackServer, "--database", stackDatabase, "--out", stackIdentityBefore,
  ]);

  const deployFixture = join(temp, "deploy-warmup"); mkdirSync(deployFixture);
  const warmCounts = { criticalDiscovered: 4, criticalRendered: 4, criticalCacheApplicable: 1, criticalCacheVerified: 1, criticalUnpublishedDuringWarmup: 0, cmsDiscovered: 2, cmsRendered: 2, cmsCacheApplicable: 2, cmsCacheVerified: 2, cmsFailed: 0, cmsUnpublishedDuringWarmup: 0 };
  const deployJson = join(deployFixture, "json.json"); json(deployJson, { status: 200, cache_control: "no-store", report: { verdict: "pass", origin: "http://127.0.0.1:3000", concurrencyLimit: 2, peakConcurrency: 2, failures: [], blockingReasons: [], counts: warmCounts } });
  const deployText = join(deployFixture, "text.json"); json(deployText, { status: 200, cache_control: "no-store", body: "summary\nWARMUP-GATE-VERDICT: pass\n" });
  const deployContainer = join(deployFixture, "container.json"); json(deployContainer, { image_id: imageId });
  run(process.execPath, ["measurement/current-main-refresh/bin/analyse-deploy-warmup.mjs", "--json-response", deployJson, "--text-response", deployText, "--container", deployContainer, "--image-id", imageId, "--out", join(deployFixture, "analysis.json")]);
  const immutableOut = join(temp, "immutable-inputs.json");
  const immutableArgs = [
    resolve(repo, "measurement/current-main-refresh/bin/create-immutable-inputs.mjs"), "--run-id", "self-test", "--side", "current",
    "--app-source-archive", sourceArchive, "--app-source-sha256", sha(sourceArchive), "--app-source-commit", head,
    "--producer-source-archive", producerArchive, "--producer-source-sha256", sha(producerArchive), "--producer-source-commit", producerCommit,
    "--image-reference", imageId, "--image-id", imageId, "--oci-revision", head,
    "--database-archive", databaseArchive, "--database-sha256", sha(databaseArchive), "--database-fingerprint", "b".repeat(64),
    "--census", censusCopy, "--census-sha256", sha(censusCopy),
    "--writer-census", writerCensusCopy, "--writer-census-sha256", sha(writerCensusCopy),
    "--producer-files", producerManifest, "--producer-files-sha256", sha(producerManifest),
    "--image-inspect", imageInspect, "--image-inspect-sha256", sha(imageInspect),
    "--container-inspect", containerInspect, "--container-inspect-sha256", sha(containerInspect),
    "--image-build-raw", imageBuildRaw, "--image-build-raw-sha256", sha(imageBuildRaw),
    "--image-build-evidence", imageBuildEvidence, "--image-build-evidence-sha256", sha(imageBuildEvidence),
    "--image-build-runtime", imageBuildRuntime, "--image-build-runtime-sha256", sha(imageBuildRuntime),
    "--runtime-provenance", runtimeProvenance, "--runtime-provenance-sha256", sha(runtimeProvenance),
    "--stack-identity-before", stackIdentityBefore, "--stack-identity-before-sha256", sha(stackIdentityBefore),
    "--base-url", "http://127.0.0.1:8027", "--compose-project", "tacbookings-measure", "--release-id-sha256", "c".repeat(64),
  ];
  runIn(runtimeRoot, process.execPath, [...immutableArgs, "--out", immutableOut]);
  const immutable = JSON.parse(readFileSync(immutableOut, "utf8"));
  if (immutable.source.commit !== head || immutable.producer_source.commit !== producerCommit || immutable.image.id !== imageId || immutable.database.logical_fingerprint_before !== "b".repeat(64) || immutable.stack_identity_before.sha256 !== sha(stackIdentityBefore) || immutable.image.build_evidence.typed_sha256 !== sha(imageBuildEvidence) || immutable.writer_census_sha256 !== sha(writerCensusCopy) || immutable.runtime_provenance.sha256 !== sha(runtimeProvenance)) {
    throw new Error("immutable-input capture lost an exact identity binding");
  }
  const invalidRuntimeProvenance = join(temp, "invalid-runtime-provenance.json");
  json(invalidRuntimeProvenance, { ...JSON.parse(readFileSync(runtimeProvenance, "utf8")), chromium: { ...JSON.parse(readFileSync(runtimeProvenance, "utf8")).chromium, revision: "not-a-revision" } });
  const invalidRuntimeArgs = replaceOption(replaceOption(immutableArgs, "--runtime-provenance", invalidRuntimeProvenance), "--runtime-provenance-sha256", sha(invalidRuntimeProvenance));
  runIn(runtimeRoot, process.execPath, [...invalidRuntimeArgs, "--out", join(temp, "invalid-runtime-immutable-inputs.json")], false);
  const tamperedWriterCensus = join(temp, "tampered-public-writer-census.json");
  json(tamperedWriterCensus, { ...JSON.parse(readFileSync(writerCensusCopy, "utf8")), note: "not the archived census" });
  const tamperedArgs = replaceOption(replaceOption(immutableArgs, "--writer-census", tamperedWriterCensus), "--writer-census-sha256", sha(tamperedWriterCensus));
  runIn(runtimeRoot, process.execPath, [...tamperedArgs, "--out", join(temp, "tampered-immutable-inputs.json")], false);
  const changedPhase2Bytes = Buffer.concat([readFileSync(resolve(repo, "measurement/phase2/bin/statistics.mjs")), Buffer.from("\n// changed after archive creation\n")]);
  const changedPhase2Sha = createHash("sha256").update(changedPhase2Bytes).digest("hex");
  const changedPhase2Manifest = join(temp, "changed-phase2-producer-files.sha256");
  writeFileSync(changedPhase2Manifest, manifestText.replace(
    /^[a-f0-9]{64}  measurement\/phase2\/bin\/statistics\.mjs$/m,
    `${changedPhase2Sha}  measurement/phase2/bin/statistics.mjs`,
  ));
  const changedPhase2Args = replaceOption(replaceOption(immutableArgs, "--producer-files", changedPhase2Manifest), "--producer-files-sha256", sha(changedPhase2Manifest));
  runIn(runtimeRoot, process.execPath, [...changedPhase2Args, "--out", join(temp, "changed-phase2-immutable-inputs.json")], false);

  console.log("current-main correctness producer self-test: PASS");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
