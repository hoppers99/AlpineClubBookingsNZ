import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const fail = (message) => { throw new Error(`generate-source-census: ${message}`); };
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!process.argv[index]?.startsWith("--") || process.argv[index + 1] === undefined) fail("arguments must be --key value pairs");
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const required = (name) => args.get(name) ?? fail(`--${name} is required`);
const repoRoot = resolve(required("repo-root"));
const expectedPath = resolve(required("expected"));
const out = resolve(required("out"));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(dir, entry.name);
  if (entry.isDirectory()) return walk(path);
  return entry.isFile() && entry.name === "route.ts" ? [path] : [];
});
const normalize = (path) => relative(repoRoot, path).split(sep).join("/");

const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
if (expected.schema_version !== 1 || !Array.isArray(expected.writers)) fail("unsupported writer census");
const expectedByPath = new Map(expected.writers.map((writer) => [writer.path, writer]));
if (expectedByPath.size !== expected.writers.length) fail("writer census contains duplicate paths");

const discovered = [];
for (const path of walk(resolve(repoRoot, "src/app/api/admin"))) {
  const source = readFileSync(path, "utf8");
  let mechanism = null;
  if (/^\s*revalidatePublicSite\(/m.test(source)) mechanism = "revalidatePublicSite";
  else if (/^\s*revalidatePublicPageContent\(/m.test(source)) mechanism = "revalidatePublicPageContent";
  else if (/^\s*revalidatePath\(\s*["']\/["']\s*,\s*["']layout["']\s*\)/m.test(source)) mechanism = "revalidatePath-root-layout";
  if (mechanism) discovered.push({ path: normalize(path), mechanism, source_sha256: sha256(source) });
}

const discoveredByPath = new Map(discovered.map((writer) => [writer.path, writer]));
const missing = [...expectedByPath.keys()].filter((path) => !discoveredByPath.has(path));
const unexpected = [...discoveredByPath.keys()].filter((path) => !expectedByPath.has(path));
const mechanismMismatches = discovered
  .filter((writer) => expectedByPath.has(writer.path) && expectedByPath.get(writer.path).mechanism !== writer.mechanism)
  .map((writer) => ({ path: writer.path, expected: expectedByPath.get(writer.path).mechanism, actual: writer.mechanism }));
if (missing.length || unexpected.length || mechanismMismatches.length) {
  fail(`writer census drift: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)} mechanisms=${JSON.stringify(mechanismMismatches)}`);
}

const pageRoutePath = resolve(repoRoot, "src/app/api/admin/page-content/route.ts");
const pageRoute = readFileSync(pageRoutePath, "utf8");
const methods = [...pageRoute.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]);
if (methods.includes("DELETE")) fail("page-content DELETE endpoint now exists; MC-03D must be re-evaluated, not silently kept blocked");

const inventory = expected.writers.map((writer) => ({
  ...writer,
  source_sha256: discoveredByPath.get(writer.path).source_sha256,
  runtime_coverage: writer.runtime_producer ? "named" : "missing",
}));
const result = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_root: repoRoot,
  expected_census_sha256: sha256(readFileSync(expectedPath)),
  writer_count: inventory.length,
  structural_census_complete: true,
  runtime_coverage_complete: inventory.every((writer) => writer.runtime_producer),
  writers: inventory,
  cms_page_content_endpoint: {
    path: normalize(pageRoutePath),
    source_sha256: sha256(pageRoute),
    exported_methods: methods.sort(),
    delete_endpoint_present: false,
    disposition: "OWNER_DISPOSITION_NEEDED"
  }
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
