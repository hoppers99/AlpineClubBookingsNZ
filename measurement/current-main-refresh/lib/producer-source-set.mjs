import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SHARED_PATHS = new Set([
  "Caddyfile.staging",
  "docker-compose.yml",
  "measurement/stack/docker-compose.measure.yml",
  "measurement/stack/measure-stack.sh",
]);

const REQUIRED_PATHS = [
  "Caddyfile.staging",
  "docker-compose.yml",
  "measurement/current-main-refresh/check-census.json",
  "measurement/current-main-refresh/public-writer-census.json",
  "measurement/current-main-refresh/bin/resolve-measure-container.mjs",
  "measurement/current-main-refresh/bin/runtime-provenance.mjs",
  "measurement/current-main-refresh/bin/validate-orchestrator-inputs.mjs",
  "measurement/current-main-refresh/run-correctness-producers.sh",
  "measurement/current-main-refresh/lib/git-tar.mjs",
  "measurement/current-main-refresh/lib/local-auth-state.mjs",
  "measurement/current-main-refresh/lib/measure-container-identity.mjs",
  "measurement/current-main-refresh/lib/producer-source-set.mjs",
  "measurement/current-main-refresh/lib/write-producer-result.mjs",
  "measurement/phase2/README.md",
  "measurement/phase2/bin/finalize-run.mjs",
  "measurement/phase2/bin/orchestrate-pairs.sh",
  "measurement/phase2/bin/run-phase2.sh",
  "measurement/phase2/bin/verify-harness-manifest.mjs",
  "measurement/stack/docker-compose.measure.yml",
  "measurement/stack/measure-stack.sh",
];

const isSelected = (path) =>
  path.startsWith("measurement/current-main-refresh/") ||
  (path.startsWith("measurement/phase2/") && !path.startsWith("measurement/phase2/results/")) ||
  SHARED_PATHS.has(path);

const isSensitive = (path) => {
  const basename = path.split("/").at(-1);
  return /^\.env(?:\.|$)/i.test(basename) || /\.(?:key|pem|p12|pfx)$/i.test(basename) || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i.test(basename);
};

export function selectProducerSourceMembers(archive) {
  const rows = [];
  for (const [path, member] of archive.members) {
    if (!isSelected(path)) continue;
    if (isSensitive(path)) throw new Error(`producer source set contains forbidden environment or key material: ${path}`);
    rows.push({ path, sha256: member.sha256 });
  }
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const selected = new Set(rows.map((row) => row.path));
  for (const required of REQUIRED_PATHS) {
    if (!selected.has(required)) throw new Error(`producer source archive omits ${required}`);
  }
  return rows;
}

const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const comparePath = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function verifyLiveProducerSource(archive, inputRoot) {
  if (!isAbsolute(inputRoot)) throw new Error("live producer root must be absolute");
  const root = resolve(inputRoot);
  const rootStat = lstatSync(root); const rootReal = realpathSync(root);
  const sameRoot = process.platform === "win32" ? root.toLowerCase() === rootReal.toLowerCase() : root === rootReal;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !sameRoot) throw new Error("live producer root is not a canonical directory");
  const expected = selectProducerSourceMembers(archive);
  const discovered = [];
  const walk = (relativeDirectory) => {
    const absoluteDirectory = join(root, ...relativeDirectory.split("/"));
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const path = `${relativeDirectory}/${entry.name}`;
      if (path === "measurement/phase2/results" || path.startsWith("measurement/phase2/results/")) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) discovered.push(path);
      else throw new Error(`live producer source contains a special file: ${path}`);
    }
  };
  walk("measurement/current-main-refresh");
  walk("measurement/phase2");
  for (const path of SHARED_PATHS) discovered.push(path);
  discovered.sort(comparePath);
  const expectedPaths = expected.map((row) => row.path);
  if (JSON.stringify(discovered) !== JSON.stringify(expectedPaths)) {
    const missing = expectedPaths.filter((path) => !discovered.includes(path));
    const extra = discovered.filter((path) => !expectedPaths.includes(path));
    throw new Error(`live producer source set differs from archive: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
  for (const row of expected) {
    const path = resolve(root, ...row.path.split("/"));
    const stat = lstatSync(path); const real = realpathSync(path);
    const withinRoot = relative(root, real);
    const samePath = process.platform === "win32" ? path.toLowerCase() === real.toLowerCase() : path === real;
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath || !withinRoot || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) throw new Error(`live producer member is not a canonical in-root regular file: ${row.path}`);
    if (hashFile(path) !== row.sha256) throw new Error(`live producer member differs from archive: ${row.path}`);
  }
  const sourceSetSha256 = createHash("sha256").update(expected.map((row) => `${row.sha256}  ${row.path}\n`).join("")).digest("hex");
  return { schema_version: 1, verified: true, files: expected.length, source_set_sha256: sourceSetSha256 };
}
