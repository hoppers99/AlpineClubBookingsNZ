import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readGitTarArchive } from "../lib/git-tar.mjs";

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
};
const archive = readGitTarArchive(arg("app-source-archive"), arg("app-source-commit"));
const rootLayout = "src/app/layout.tsx";
const routeSources = new Map([
  ["/", "src/app/(website)/page.tsx"],
  ["/about", "src/app/(website)/[...slug]/page.tsx"],
  ["/join", "src/app/(website)/join/page.tsx"],
  ["/contact", "src/app/(website)/contact/page.tsx"],
  ["/join/apply", "src/app/(website)/join/apply/page.tsx"],
]);
const source = (path) => {
  const member = archive.members.get(path);
  if (!member) throw new Error(`application source archive omits metadata source: ${path}`);
  return { path, sha256: member.sha256, body: member.bytes.toString("utf8") };
};
const layout = source(rootLayout);
if (!/metadataBase:\s*new URL\(baseUrl\)/.test(layout.body)) throw new Error("root metadata base contract drifted");
const rows = [];
for (const [route, path] of routeSources) {
  const page = source(path);
  if (!/export async function generateMetadata\b/.test(page.body)) throw new Error(`${path} has no explicit metadata contract`);
  if (/\balternates\s*:|\bcanonical\s*:/.test(`${layout.body}\n${page.body}`)) throw new Error(`${route} now declares canonical metadata; review and update the explicit expected contract`);
  rows.push({ route, expectation: { kind: "absent", count: 0 }, source_paths: [layout.path, page.path], source_sha256: [layout.sha256, page.sha256] });
}
writeFileSync(resolve(arg("out")), JSON.stringify({
  schema_version: 1,
  app_source_commit: archive.revision,
  app_source_archive_sha256: archive.archive_sha256,
  derivation: "Neither the root nor route generateMetadata contract declares alternates.canonical; rendered canonical links must therefore be absent",
  routes: rows,
}, null, 2) + "\n", { flag: "wx" });
