import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const fail = (message) => { throw new Error(`analyse-route-manifests: ${message}`); };
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!process.argv[index]?.startsWith("--") || process.argv[index + 1] === undefined) fail("arguments must be --key value pairs");
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const required = (name) => args.get(name) ?? fail(`--${name} is required`);
const side = required("side");
if (!new Set(["current", "baseline"]).has(side)) fail("unsupported side");
const load = (name) => JSON.parse(readFileSync(resolve(required(name)), "utf8"));
const appPaths = load("app-paths");
const prerender = load("prerender");
const routes = load("routes");
const out = resolve(required("out"));

const approved = ["/", "/[...slug]", "/join", "/contact", "/join/apply"];
const narrowed = ["/hut-leader-instructions", "/join/[code]", "/join/verify/[token]"];
const appValues = new Set(Object.values(appPaths));
for (const route of [...approved, ...narrowed]) if (!appValues.has(route)) fail(`app path manifest is missing ${route}`);

const staticRoutes = Object.keys(prerender.routes ?? {});
const dynamicRoutes = Object.keys(prerender.dynamicRoutes ?? {});
for (const route of ["/", "/join", "/contact", "/join/apply", ...narrowed]) {
  if (staticRoutes.includes(route) || dynamicRoutes.includes(route)) fail(`${route} unexpectedly entered the prerender manifest`);
}
if (side === "current") {
  if (!dynamicRoutes.includes("/[...slug]")) fail("current CMS catch-all is absent from prerender dynamicRoutes");
  const publicDynamic = dynamicRoutes.filter((route) => route === "/[...slug]" || approved.includes(route) || narrowed.includes(route));
  if (JSON.stringify(publicDynamic) !== JSON.stringify(["/[...slug]"])) fail(`current public ISR census drifted: ${JSON.stringify(publicDynamic)}`);
} else if (dynamicRoutes.includes("/[...slug]") || staticRoutes.includes("/[...slug]")) {
  fail("baseline unexpectedly contains the slice-1 CMS ISR route");
}

const sha = (name) => createHash("sha256").update(readFileSync(resolve(required(name)))).digest("hex");
writeFileSync(out, `${JSON.stringify({
  schema_version: 1,
  side,
  approved_routes: approved,
  narrowed_routes: narrowed,
  cms_catch_all_isr: side === "current",
  public_isr_routes: side === "current" ? ["/[...slug]"] : [],
  manifest_sha256: { app_paths: sha("app-paths"), prerender: sha("prerender"), routes: sha("routes") },
  manifest_counts: { app_paths: Object.keys(appPaths).length, prerender_static: staticRoutes.length, prerender_dynamic: dynamicRoutes.length, routes: (routes.staticRoutes?.length ?? 0) + (routes.dynamicRoutes?.length ?? 0) },
}, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
