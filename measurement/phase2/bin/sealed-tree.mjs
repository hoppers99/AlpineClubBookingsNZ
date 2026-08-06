import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

const fail = (message) => { throw new Error(message); };
export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fold = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const real = (path) => realpathSync.native(resolve(path));

export function isPathInside(parent, child, allowEqual = false) {
  const parentReal = fold(real(parent));
  const childReal = fold(real(child));
  return (allowEqual && childReal === parentReal) || childReal.startsWith(`${parentReal}${sep}`);
}

export function resolveFutureRealPath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) fail(`cannot resolve an existing ancestor for ${path}`);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  if (!statSync(cursor).isDirectory()) fail(`future path ancestor is not a directory: ${cursor}`);
  return resolve(real(cursor), ...suffix);
}

export function isFuturePathInside(parent, futurePath) {
  const parentReal = fold(real(parent));
  const futureReal = fold(resolveFutureRealPath(futurePath));
  return futureReal === parentReal || futureReal.startsWith(`${parentReal}${sep}`);
}

function walk(root, dir = root, result = { files: [], directories: [] }) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) fail(`sealed tree contains a symbolic link or junction: ${path}`);
    const rel = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      result.directories.push(rel);
      walk(root, path, result);
    } else if (entry.isFile()) result.files.push(rel);
    else fail(`sealed tree contains an unsupported filesystem entry: ${path}`);
  }
  return result;
}

function validateRelativePath(value, label) {
  if (typeof value !== "string" || value === "" || isAbsolute(value) || value.includes("\\") || /[\0\r\n\t]/.test(value) || posix.normalize(value) !== value || value === ".." || value.startsWith("../")) {
    fail(`${label} is not a canonical relative path: ${value}`);
  }
  return value;
}

function expectedDirectories(files) {
  const result = new Set();
  for (const file of files) {
    let parent = posix.dirname(file);
    while (parent !== ".") {
      result.add(parent);
      parent = posix.dirname(parent);
    }
  }
  return [...result].sort();
}

export function finalizeSealedTree({ root, manifestName = "output-manifest.sha256", completionName = "COMPLETED.json", completionFields = {} }) {
  const rootPath = real(root);
  if (!statSync(rootPath).isDirectory()) fail(`seal root is not a directory: ${rootPath}`);
  const manifestPath = join(rootPath, manifestName);
  const completionPath = join(rootPath, completionName);
  if (existsSync(manifestPath) || existsSync(completionPath)) fail("seal output already exists");
  const census = walk(rootPath);
  if (census.files.length === 0) fail("refusing to seal an empty tree");
  const records = census.files.sort().map((path) => {
    const absolute = join(rootPath, ...path.split("/"));
    return { path, bytes: statSync(absolute).size, sha256: sha256File(absolute) };
  });
  writeFileSync(manifestPath, `${records.map((record) => `${record.sha256}  ${record.bytes}  ${record.path}`).join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  const sealedFiles = [...census.files, manifestName, completionName];
  const completion = {
    ...completionFields,
    schema_version: 2,
    output_manifest_sha256: sha256File(manifestPath),
    artifact_count: records.length,
    sealed_file_count: sealedFiles.length,
    sealed_directory_count: expectedDirectories(sealedFiles).length,
    status: "COMPLETE",
  };
  writeFileSync(completionPath, `${JSON.stringify(completion, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { root: rootPath, manifestPath, completionPath, completion, records };
}

export function verifySealedTree(root, { manifestName = "output-manifest.sha256", completionName = "COMPLETED.json" } = {}) {
  const rootPath = real(root);
  if (!statSync(rootPath).isDirectory()) fail(`sealed root is not a directory: ${rootPath}`);
  const manifestPath = join(rootPath, manifestName);
  const completionPath = join(rootPath, completionName);
  if (!existsSync(manifestPath) || !existsSync(completionPath)) fail(`sealed tree is incomplete: ${rootPath}`);
  const completion = JSON.parse(readFileSync(completionPath, "utf8"));
  if (completion.schema_version !== 2 || completion.status !== "COMPLETE" || sha256File(manifestPath) !== completion.output_manifest_sha256) fail(`sealed completion binding is invalid: ${rootPath}`);
  const records = new Map();
  const folded = new Set();
  for (const [index, line] of readFileSync(manifestPath, "utf8").trim().split(/\r?\n/).entries()) {
    const match = /^([a-f0-9]{64})  (\d+)  (.+)$/.exec(line);
    if (!match) fail(`invalid sealed manifest line ${index + 1}`);
    const path = validateRelativePath(match[3], `sealed manifest line ${index + 1}`);
    const key = fold(path);
    if (folded.has(key)) fail(`duplicate case-insensitive sealed path: ${path}`);
    folded.add(key);
    const absolute = join(rootPath, ...path.split("/"));
    if (!existsSync(absolute) || !statSync(absolute).isFile() || !isPathInside(rootPath, absolute)) fail(`sealed manifest path is missing or escapes root: ${path}`);
    if (statSync(absolute).size !== Number(match[2]) || sha256File(absolute) !== match[1]) fail(`sealed manifest checksum mismatch: ${path}`);
    records.set(path, { sha256: match[1], bytes: Number(match[2]), absolute });
  }
  const expectedFiles = [...records.keys(), manifestName, completionName].sort();
  const expectedDirs = expectedDirectories(expectedFiles);
  const census = walk(rootPath);
  const foldedActualFiles = census.files.map(fold).sort();
  const foldedExpectedFiles = expectedFiles.map(fold).sort();
  const foldedActualDirs = census.directories.map(fold).sort();
  const foldedExpectedDirs = expectedDirs.map(fold).sort();
  if (JSON.stringify(foldedActualFiles) !== JSON.stringify(foldedExpectedFiles) || JSON.stringify(foldedActualDirs) !== JSON.stringify(foldedExpectedDirs)) fail(`sealed filesystem census differs from manifest: ${rootPath}`);
  if (completion.artifact_count !== records.size || completion.sealed_file_count !== expectedFiles.length || completion.sealed_directory_count !== expectedDirs.length) fail(`sealed completion census differs from filesystem: ${rootPath}`);
  return { root: rootPath, manifestPath, completionPath, completion, records, files: expectedFiles, directories: expectedDirs };
}
