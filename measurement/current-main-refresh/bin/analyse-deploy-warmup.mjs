import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
};
const parse = (name) => JSON.parse(readFileSync(resolve(arg(name)), "utf8"));
const jsonResponse = parse("json-response");
const textResponse = parse("text-response");
const container = parse("container");
const expectedImageId = arg("image-id");
if (container?.image_id !== expectedImageId || !/^sha256:[a-f0-9]{64}$/.test(expectedImageId)) throw new Error("warm-up did not run in the selected image");
if (jsonResponse?.status !== 200 || !String(jsonResponse?.cache_control).includes("no-store")) throw new Error("direct JSON warm-up response was not a non-cacheable 200");
const report = jsonResponse.report;
if (report?.verdict !== "pass" || report.origin !== "http://127.0.0.1:3000" || report.concurrencyLimit !== 2 || !Number.isSafeInteger(report.peakConcurrency) || report.peakConcurrency < 1 || report.peakConcurrency > 2) {
  throw new Error("direct JSON warm-up did not prove the expected target, verdict, and concurrency");
}
if (!Array.isArray(report.failures) || report.failures.length !== 0 || !Array.isArray(report.blockingReasons) || report.blockingReasons.length !== 0) throw new Error("direct warm-up reported a failure");
const counts = report.counts;
for (const key of ["criticalDiscovered","criticalRendered","criticalCacheApplicable","criticalCacheVerified","criticalUnpublishedDuringWarmup","cmsDiscovered","cmsRendered","cmsCacheApplicable","cmsCacheVerified","cmsFailed","cmsUnpublishedDuringWarmup"]) {
  if (!Number.isSafeInteger(counts?.[key]) || counts[key] < 0) throw new Error(`warm-up count is invalid: ${key}`);
}
if (counts.criticalDiscovered < 1 || counts.criticalRendered !== counts.criticalDiscovered || counts.criticalCacheVerified !== counts.criticalCacheApplicable || counts.criticalUnpublishedDuringWarmup !== 0) throw new Error("critical route warm-up was incomplete");
if (counts.cmsDiscovered < 1 || counts.cmsRendered !== counts.cmsDiscovered || counts.cmsCacheVerified !== counts.cmsCacheApplicable || counts.cmsFailed !== 0 || counts.cmsUnpublishedDuringWarmup !== 0) throw new Error("CMS route warm-up was incomplete");
if (textResponse?.status !== 200 || !String(textResponse?.cache_control).includes("no-store") || !String(textResponse?.body).split(/\r?\n/).includes("WARMUP-GATE-VERDICT: pass")) {
  throw new Error("direct text warm-up did not carry the pass sentinel");
}
writeFileSync(resolve(arg("out")), JSON.stringify({
  schema_version: 1,
  image_id: expectedImageId,
  direct_origin: report.origin,
  verdict: report.verdict,
  critical: {
    discovered: counts.criticalDiscovered,
    rendered: counts.criticalRendered,
    cache_applicable: counts.criticalCacheApplicable,
    cache_verified: counts.criticalCacheVerified,
  },
  cms: {
    discovered: counts.cmsDiscovered,
    rendered: counts.cmsRendered,
    cache_applicable: counts.cmsCacheApplicable,
    cache_verified: counts.cmsCacheVerified,
  },
  text_sentinel: "WARMUP-GATE-VERDICT: pass",
}, null, 2) + "\n", { flag: "wx" });
