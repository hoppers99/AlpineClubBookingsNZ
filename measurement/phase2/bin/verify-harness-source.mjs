import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { EXPECTED_PRODUCER_SOURCE_PATHS, sha256File, validateProducerFilesManifest } from "./correctness-contract.mjs";
import { verifyCorrectnessCompletion } from "./verify-correctness-evidence.mjs";

const fail = (message) => { throw new Error(message); };
const fold = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const harnessPaths = () => EXPECTED_PRODUCER_SOURCE_PATHS.filter((path) => path.startsWith("measurement/phase2/bin/") || ["docker-compose.yml", "Caddyfile.staging", "measurement/stack/docker-compose.measure.yml", "measurement/stack/measure-stack.sh"].includes(path));

export function verifyHarnessAgainstProducerArchive({ harnessManifestPath, producerManifestPath, producerArchivePath, producerCommit, repoRoot }) {
  const producer = validateProducerFilesManifest(producerManifestPath, producerArchivePath);
  if (producer.archiveRevision !== producerCommit) fail("harness producer source commit differs from the archive revision");
  const root = resolve(repoRoot);
  const lines = readFileSync(harnessManifestPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const rows = [];
  const seen = new Set();
  for (const [index, line] of lines.entries()) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !isAbsolute(match[2])) fail(`invalid live harness manifest line ${index + 1}`);
    const absolute = resolve(match[2]);
    const path = relative(root, absolute).split(sep).join("/");
    if (!path || path === ".." || path.startsWith("../") || seen.has(fold(path))) fail(`live harness path is duplicate or escapes the repository: ${index + 1}`);
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile() || sha256File(absolute) !== match[1]) fail(`live harness file/checksum is invalid: ${path}`);
    if (producer.hashes.get(path) !== match[1]) fail(`live harness bytes differ from the reviewed producer source archive: ${path}`);
    seen.add(fold(path)); rows.push({ path, sha256: match[1] });
  }
  const expected = harnessPaths();
  if (JSON.stringify(rows.map((row) => row.path)) !== JSON.stringify(expected)) fail("live harness manifest differs from the exact archive-backed harness census");
  return { producer, rows, harness_manifest_sha256: sha256File(harnessManifestPath) };
}

export function buildHarnessSourceBinding({ harnessManifestPath, currentCompletionPath, baselineCompletionPath, repoRoot }) {
  const current = verifyCorrectnessCompletion(resolve(currentCompletionPath));
  const baseline = verifyCorrectnessCompletion(resolve(baselineCompletionPath));
  if (current.immutable.side !== "current" || baseline.immutable.side !== "baseline") fail("harness source binding received swapped correctness sides");
  if (current.immutable.producer_source.archive_sha256 !== baseline.immutable.producer_source.archive_sha256 || current.immutable.producer_source.commit !== baseline.immutable.producer_source.commit || current.immutable.producer_files_sha256 !== baseline.immutable.producer_files_sha256) fail("correctness sides do not share one reviewed producer source identity");
  const verified = verifyHarnessAgainstProducerArchive({
    harnessManifestPath,
    producerManifestPath: current.immutable.producer_files_path,
    producerArchivePath: current.immutable.producer_source.archive_path,
    producerCommit: current.immutable.producer_source.commit,
    repoRoot,
  });
  return {
    schema_version: 1,
    producer_source_archive_path: current.immutable.producer_source.archive_path,
    producer_source_archive_sha256: current.immutable.producer_source.archive_sha256,
    producer_source_commit: current.immutable.producer_source.commit,
    producer_files_path: current.immutable.producer_files_path,
    producer_files_sha256: current.immutable.producer_files_sha256,
    current_correctness_completion_path: resolve(currentCompletionPath),
    current_correctness_completion_sha256: sha256File(resolve(currentCompletionPath)),
    baseline_correctness_completion_path: resolve(baselineCompletionPath),
    baseline_correctness_completion_sha256: sha256File(resolve(baselineCompletionPath)),
    harness_manifest_path: resolve(harnessManifestPath),
    harness_manifest_sha256: verified.harness_manifest_sha256,
    file_count: verified.rows.length,
    files: verified.rows,
    verified: true,
  };
}

export function verifyHarnessSourceBinding({ bindingPath, harnessManifestPath, currentCompletionPath, baselineCompletionPath, repoRoot }) {
  const expected = buildHarnessSourceBinding({ harnessManifestPath, currentCompletionPath, baselineCompletionPath, repoRoot });
  const actual = JSON.parse(readFileSync(bindingPath, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("sealed harness source binding differs from the current live/archive verification");
  return actual;
}

if (import.meta.filename === process.argv[1]) {
  const allowed = new Set(["harness-manifest", "current-completion", "baseline-completion", "out", "binding"]);
  const cli = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index], value = process.argv[index + 1], name = flag?.replace(/^--/, "");
    if (!flag?.startsWith("--") || !value || !allowed.has(name) || cli.has(name)) fail("harness source arguments are malformed, duplicated, or unknown");
    cli.set(name, resolve(value));
  }
  const arg = (name, required = true) => { const value = cli.get(name); if (!value && required) fail(`--${name} is required`); return value ?? null; };
  const harnessManifestPath = arg("harness-manifest");
  const currentCompletionPath = arg("current-completion");
  const baselineCompletionPath = arg("baseline-completion");
  const out = arg("out", false);
  const binding = arg("binding", false);
  if (Boolean(out) === Boolean(binding)) fail("exactly one of --out or --binding is required");
  const options = { harnessManifestPath, currentCompletionPath, baselineCompletionPath, repoRoot: resolve(import.meta.dirname, "../../..") };
  if (binding) {
    verifyHarnessSourceBinding({ ...options, bindingPath: binding });
    console.log(JSON.stringify({ verified: true, sha256: sha256File(binding) }));
  } else {
    const result = buildHarnessSourceBinding(options);
    if (existsSync(out)) fail("harness source binding output already exists");
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ verified: true, sha256: createHash("sha256").update(readFileSync(out)).digest("hex") }));
  }
}
