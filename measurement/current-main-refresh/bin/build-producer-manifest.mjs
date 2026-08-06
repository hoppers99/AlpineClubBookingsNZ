import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
};
const repoRoot = realpathSync(resolve(arg("repo-root")));
const out = resolve(arg("out"));
const sourceRoot = resolve(repoRoot, "measurement/current-main-refresh");
const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`producer source is a symlink: ${path}`);
    if (stat.isDirectory()) walk(path);
    else if (stat.isFile()) files.push(path);
    else throw new Error(`unsupported producer source entry: ${path}`);
  }
};
walk(sourceRoot);
for (const required of [
  "measurement/stack/measure-stack.sh",
  "measurement/stack/docker-compose.measure.yml",
]) files.push(resolve(repoRoot, required));
const rows = [...new Set(files)].map((absolute) => {
  const rel = relative(repoRoot, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`source escapes repository: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`source is not a regular file: ${absolute}`);
  return {
    path: rel.split(sep).join("/"),
    sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
  };
}).sort((left, right) => left.path.localeCompare(right.path));
if (new Set(rows.map((row) => row.path)).size !== rows.length) throw new Error("duplicate producer source path");
writeFileSync(out, rows.map((row) => `${row.sha256}  ${row.path}`).join("\n") + "\n", { flag: "wx" });
