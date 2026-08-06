import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "issue-2352-correctness-self-test-"));
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (command, args, expectedSuccess = true) => {
  const result = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
  if ((result.status === 0) !== expectedSuccess) {
    throw new Error(`${command} ${args.join(" ")} ${expectedSuccess ? "failed" : "unexpectedly passed"}:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
};
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));

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

  const sourceCensusOut = join(temp, "source-census.json");
  run(process.execPath, [
    "measurement/current-main-refresh/bin/generate-source-census.mjs", "--repo-root", repo,
    "--expected", "measurement/current-main-refresh/public-writer-census.json", "--out", sourceCensusOut,
  ]);
  const sourceCensus = JSON.parse(readFileSync(sourceCensusOut, "utf8"));
  if (sourceCensus.writer_count !== 39 || !sourceCensus.structural_census_complete || sourceCensus.runtime_coverage_complete) {
    throw new Error("writer census did not preserve the honest complete-structure/incomplete-runtime result");
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
    const observationsPath = join(root, "observations.json");
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

  const producerManifest = join(temp, "producer-files.sha256");
  run(process.execPath, ["measurement/current-main-refresh/bin/build-producer-manifest.mjs", "--repo-root", repo, "--out", producerManifest]);
  const manifestText = readFileSync(producerManifest, "utf8");
  for (const path of ["self-test.mjs", "run-correctness-producers.sh", "run-stored-404.sh", "measurement/stack/measure-stack.sh"]) {
    if (!manifestText.includes(path)) throw new Error(`producer manifest omitted ${path}`);
  }

  const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const sourceArchive = join(temp, "source.tar");
  run("git", ["archive", "--format=tar", `--output=${sourceArchive}`, head]);
  const databaseArchive = join(temp, "database.dump"); writeFileSync(databaseArchive, "canonical database fixture\n");
  const imageId = `sha256:${"a".repeat(64)}`;
  const imageInspect = join(temp, "image-inspect.json"); json(imageInspect, { id: imageId, oci_revision: head });
  const containerInspect = join(temp, "container-inspect.json"); json(containerInspect, { id: "container", image_id: imageId, compose_project: "tacbookings-measure", compose_service: "app" });
  const censusCopy = join(temp, "check-census.json"); cpSync(censusPath, censusCopy);
  const immutableOut = join(temp, "immutable-inputs.json");
  run(process.execPath, [
    "measurement/current-main-refresh/bin/create-immutable-inputs.mjs", "--run-id", "self-test", "--side", "current",
    "--source-archive", sourceArchive, "--source-sha256", sha(sourceArchive), "--source-commit", head,
    "--image-reference", imageId, "--image-id", imageId, "--oci-revision", head,
    "--database-archive", databaseArchive, "--database-sha256", sha(databaseArchive), "--database-fingerprint", "b".repeat(64),
    "--census", censusCopy, "--census-sha256", sha(censusCopy), "--producer-files", producerManifest, "--producer-files-sha256", sha(producerManifest),
    "--image-inspect", imageInspect, "--image-inspect-sha256", sha(imageInspect),
    "--container-inspect", containerInspect, "--container-inspect-sha256", sha(containerInspect),
    "--base-url", "http://127.0.0.1:8027", "--compose-project", "tacbookings-measure", "--release-id-sha256", "c".repeat(64),
    "--out", immutableOut,
  ]);
  const immutable = JSON.parse(readFileSync(immutableOut, "utf8"));
  if (immutable.source.commit !== head || immutable.image.id !== imageId || immutable.database.logical_fingerprint_before !== "b".repeat(64)) {
    throw new Error("immutable-input capture lost an exact identity binding");
  }

  console.log("current-main correctness producer self-test: PASS");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
