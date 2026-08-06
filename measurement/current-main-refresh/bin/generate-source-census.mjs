import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readGitTarArchive } from "../lib/git-tar.mjs";

const fail = (message) => { throw new Error(`generate-source-census: ${message}`); };
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!process.argv[index]?.startsWith("--") || process.argv[index + 1] === undefined) fail("arguments must be --key value pairs");
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const required = (name) => args.get(name) ?? fail(`--${name} is required`);
const expectedPath = resolve(required("expected"));
const out = resolve(required("out"));
const archive = readGitTarArchive(required("app-source-archive"), required("app-source-commit"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const member = (path) => {
  const found = archive.members.get(path);
  if (!found) fail(`application source archive omits ${path}`);
  return { path, source_sha256: found.sha256, source: found.bytes.toString("utf8") };
};

const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
if (expected.schema_version !== 1 || !Array.isArray(expected.writers)) fail("unsupported writer census");
const expectedByPath = new Map(expected.writers.map((writer) => [writer.path, writer]));
if (expectedByPath.size !== expected.writers.length) fail("writer census contains duplicate paths");

const discovered = [];
for (const [path, archived] of archive.members) {
  if (!path.startsWith("src/app/api/admin/") || !path.endsWith("/route.ts")) continue;
  const source = archived.bytes.toString("utf8");
  let mechanism = null;
  if (/^\s*revalidatePublicSite\(/m.test(source)) mechanism = "revalidatePublicSite";
  else if (/^\s*revalidatePublicPageContent\(/m.test(source)) mechanism = "revalidatePublicPageContent";
  else if (/^\s*revalidatePath\(\s*["']\/["']\s*,\s*["']layout["']\s*\)/m.test(source)) mechanism = "revalidatePath-root-layout";
  if (mechanism) discovered.push({ path, mechanism, source_sha256: archived.sha256 });
}
const discoveredByPath = new Map(discovered.map((writer) => [writer.path, writer]));
const missing = [...expectedByPath.keys()].filter((path) => !discoveredByPath.has(path));
const unexpected = [...discoveredByPath.keys()].filter((path) => !expectedByPath.has(path));
const mechanismMismatches = discovered
  .filter((writer) => expectedByPath.has(writer.path) && expectedByPath.get(writer.path).mechanism !== writer.mechanism)
  .map((writer) => ({ path: writer.path, expected: expectedByPath.get(writer.path).mechanism, actual: writer.mechanism }));
if (missing.length || unexpected.length || mechanismMismatches.length) fail(`writer census drift: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)} mechanisms=${JSON.stringify(mechanismMismatches)}`);

const canonicalHelper = member("src/lib/public-content-revalidation.ts");
if (!/export function revalidatePublicSite[\s\S]*?revalidatePath\("\/", "layout"\);[\s\S]*?invalidatePublicLayoutConfig\(/.test(canonicalHelper.source)) fail("canonical public invalidation helper no longer composes full-route and tagged-data invalidation");
if (!/export function revalidatePublicPageContent\(\): void \{\s*revalidatePublicSite\(\);\s*\}/.test(canonicalHelper.source)) fail("public page-content invalidation is no longer an exact alias of the canonical helper");
const focusedEvidence = [
  ["src/lib/__tests__/public-content-invalidation-contract.test.ts", "public site full-route invalidation contract"],
  ["src/lib/__tests__/public-layout-cache-writers.test.ts", "public layout cache writer invalidation"],
  ["src/lib/__tests__/site-style-api.test.ts", "revalidatePublicSite"],
  ["src/lib/__tests__/adult-member-hosting-policy-route.test.ts", "revalidates"],
  ["src/app/api/admin/integrations/analytics/__tests__/route.test.ts", "revalidatePublicSite"],
  ["e2e/static-cms-pages.spec.ts", "unpublish"],
].map(([path, requiredText]) => {
  const evidence = member(path);
  if (!evidence.source.includes(requiredText)) fail(`focused contract evidence drifted: ${path}`);
  return { path, source_sha256: evidence.source_sha256, archive_member: true, evidence_level: path.startsWith("e2e/") ? "tracked-real-server-test-source" : "tracked-focused-unit-or-route-test-source" };
});

const pageRoute = member("src/app/api/admin/page-content/route.ts");
const methods = [...pageRoute.source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]);
if (methods.includes("DELETE")) fail("page-content DELETE endpoint now exists; MC-03D must be re-evaluated, not silently kept blocked");
const inventory = expected.writers.map((writer) => ({
  ...writer,
  source_sha256: discoveredByPath.get(writer.path).source_sha256,
  archive_member: true,
  canonical_resolution: writer.mechanism === "revalidatePublicPageContent"
    ? "revalidatePublicPageContent -> revalidatePublicSite -> full-route plus tagged-data invalidation"
    : writer.mechanism === "revalidatePublicSite"
      ? "revalidatePublicSite -> full-route plus tagged-data invalidation"
      : "direct canonical full-route invalidation plus route-owned tagged-data invalidation where applicable",
  evidence_level: writer.runtime_producer ? "structural-plus-named-runtime-representative" : "structural-canonical-contract",
}));
const result = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  app_source_archive_path: archive.path,
  app_source_archive_sha256: archive.archive_sha256,
  app_source_commit: archive.revision,
  archive_membership_complete: true,
  expected_census_sha256: sha256(readFileSync(expectedPath)),
  writer_count: inventory.length,
  structural_census_complete: true,
  canonical_invalidation_complete: inventory.every((writer) => writer.canonical_resolution),
  runtime_exhaustive: false,
  runtime_evidence_policy: "The complete writer set is proved structurally against the canonical invalidation mechanism; runtime exercises representative writer families and is not described as exhaustive",
  representative_runtime_producers: ["cms-lifecycle", "public-layout-writers", "adult-hosting"],
  canonical_helper: { path: canonicalHelper.path, source_sha256: canonicalHelper.source_sha256, archive_member: true, full_route_and_tagged_data: true },
  focused_contract_evidence: focusedEvidence,
  writers: inventory,
  cms_page_content_endpoint: { path: pageRoute.path, source_sha256: pageRoute.source_sha256, archive_member: true, exported_methods: methods.sort(), delete_endpoint_present: false, disposition: "OWNER_DISPOSITION_NEEDED" },
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
