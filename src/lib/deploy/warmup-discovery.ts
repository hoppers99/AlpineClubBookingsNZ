import "server-only";

import fs from "node:fs";
import path from "node:path";
import { getConfiguredBookNowPagePath } from "@/lib/book-now-config";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { listPublishedCmsPagePaths } from "@/lib/page-content-html";
import type { ReleaseIdentityCheck } from "@/lib/deploy/warmup-evaluate";
import {
  buildWarmupPlan,
  type IsrDynamicRoute,
  type RouteTableSnapshot,
  type WarmupPlan,
} from "@/lib/deploy/warmup-route-policy";

/**
 * The impure half of pre-cutover route discovery (#2566): reads the target
 * release's OWN build output off disk and its published CMS pages out of the
 * database, then hands both to the pure planner in `warmup-route-policy.ts`.
 *
 * ## Why the build output, and why these two files
 *
 * The owner's decision requires discovery from authoritative sources — "the
 * Next.js prerender manifest or another authoritative build output" — rather than
 * from a hand-maintained list. Two manifests are needed, not one, and the second
 * is the one a first cut would miss:
 *
 *  • `prerender-manifest.json` says what is STORED: `routes` (build-time HTML) and
 *    `dynamicRoutes` (generated on demand and then stored, with the build's own
 *    matching regex). `scripts/ci/check-website-prerender-manifest.mjs` already
 *    audits this file in CI against closed lists, so the two agree by
 *    construction: CI proves the manifest's shape on the commit, and this reads
 *    the same file inside the running release.
 *  • `app-path-routes-manifest.json` says what EXISTS. Without it a per-request
 *    route is indistinguishable from an address no route claims: `/join` appears in
 *    neither half of the prerender manifest (it is `force-dynamic`), and it also
 *    matches the `/[...slug]` catch-all's regex. Classifying it from the prerender
 *    manifest alone would call it a stored page, and the gate would then demand a
 *    cache hit that can never come.
 *
 * **Both files are present in the deployed artifact, verified rather than assumed.**
 * `node_modules/next/dist/build/index.js` lists `PRERENDER_MANIFEST` and
 * `APP_PATH_ROUTES_MANIFEST` among the files copied into `.next/standalone`, and
 * `Dockerfile` copies that directory to `/app`. So the runner's working directory
 * holds `.next/prerender-manifest.json` and `.next/app-path-routes-manifest.json`.
 * A missing or unreadable file is a route-discovery failure and blocks cutover —
 * the owner's decision names that among the critical failures, and the alternative
 * (assume nothing is stored) would turn the gate into a 200 checker.
 */

const PRERENDER_MANIFEST_FILE = "prerender-manifest.json";
const APP_PATH_ROUTES_MANIFEST_FILE = "app-path-routes-manifest.json";

/** Where the build output sits at runtime: `<cwd>/.next`, as Next resolves it. */
export function defaultDistDir(): string {
  return path.join(process.cwd(), ".next");
}

function readJsonFile(
  filePath: string,
): { value: unknown } | { problem: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {
      problem: `Build output ${path.basename(filePath)} could not be read from ${filePath}, so the routes this release stores cannot be established.`,
    };
  }

  try {
    return { value: JSON.parse(raw) };
  } catch {
    return {
      problem: `Build output ${path.basename(filePath)} is not readable JSON, so the routes this release stores cannot be established.`,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The release's route table, or the plain-English reason it could not be read.
 *
 * Strict about shape on purpose: every branch that would otherwise "carry on with
 * what we could parse" is a branch that quietly narrows what the gate proves.
 */
export function readRouteTableSnapshot(
  distDir: string = defaultDistDir(),
): { table: RouteTableSnapshot } | { problem: string } {
  const prerender = readJsonFile(path.join(distDir, PRERENDER_MANIFEST_FILE));
  if ("problem" in prerender) {
    return prerender;
  }

  const appPaths = readJsonFile(
    path.join(distDir, APP_PATH_ROUTES_MANIFEST_FILE),
  );
  if ("problem" in appPaths) {
    return appPaths;
  }

  if (!isRecord(prerender.value) || !isRecord(appPaths.value)) {
    return {
      problem:
        "The build output manifests are not objects, so this release's route table cannot be established.",
    };
  }

  const routesValue = prerender.value.routes;
  const dynamicValue = prerender.value.dynamicRoutes;
  if (!isRecord(routesValue) || !isRecord(dynamicValue)) {
    return {
      problem:
        "The prerender manifest is missing its routes or dynamicRoutes section, so the routes this release stores cannot be established.",
    };
  }

  const prebuiltRoutes = Object.entries(routesValue).map(
    ([routePath, entry]) => ({
      path: routePath,
      // `Revalidate` is `number | false` in next's own types: a number means the
      // build-time copy refreshes (so there IS a store to verify), false means it is
      // frozen for the life of the release.
      revalidates:
        isRecord(entry) && typeof entry.initialRevalidateSeconds === "number",
    }),
  );

  const isrDynamicRoutes: IsrDynamicRoute[] = [];
  for (const [pattern, entry] of Object.entries(dynamicValue)) {
    const routeRegex =
      isRecord(entry) && typeof entry.routeRegex === "string"
        ? entry.routeRegex
        : null;
    if (!routeRegex) {
      return {
        problem: `The prerender manifest lists stored route "${pattern}" with no usable route regex, so the gate cannot tell which addresses it claims.`,
      };
    }
    isrDynamicRoutes.push({ pattern, routeRegex });
  }

  const appRoutePatterns = Object.values(appPaths.value).filter(
    (value): value is string => typeof value === "string",
  );
  if (appRoutePatterns.length === 0) {
    return {
      problem:
        "The app route manifest lists no routes at all, so this release's route table cannot be established.",
    };
  }

  return {
    table: { appRoutePatterns, prebuiltRoutes, isrDynamicRoutes },
  };
}

export interface WarmupDiscovery {
  plan: WarmupPlan;
  /**
   * When the published-CMS list was taken. The owner's decision asks for "a clear
   * snapshot of the published CMS route list for the warm-up run", and this is the
   * instant that snapshot describes — everything the run says about a CMS page is
   * relative to it.
   */
  cmsSnapshotAt: string;
  /** How many published CMS paths the snapshot held, before any exclusion. */
  cmsPathsInSnapshot: number;
}

export interface WarmupDiscoveryDependencies {
  distDir?: string;
  readTable?: typeof readRouteTableSnapshot;
  listCmsPaths?: () => Promise<string[]>;
  bookNowPagePath?: () => Promise<string | null>;
  now?: () => Date;
}

/**
 * Discovers everything the run will ask for, from the three authoritative sources.
 *
 * A thrown database error is caught and returned as a discovery problem rather
 * than propagating: the gate's answer to "the database is unreachable" must be a
 * blocked cutover with a readable reason, not a 500 from the endpoint the deploy
 * script is reading.
 */
export async function discoverWarmupRoutes(
  dependencies: WarmupDiscoveryDependencies = {},
): Promise<WarmupDiscovery> {
  const {
    distDir,
    readTable = readRouteTableSnapshot,
    listCmsPaths = listPublishedCmsPagePaths,
    bookNowPagePath = getConfiguredBookNowPagePath,
    now = () => new Date(),
  } = dependencies;

  const cmsSnapshotAt = now().toISOString();
  const table = readTable(distDir);

  if ("problem" in table) {
    return {
      plan: { routes: [], excluded: [], problems: [table.problem], notes: [] },
      cmsSnapshotAt,
      cmsPathsInSnapshot: 0,
    };
  }

  let cmsPaths: string[];
  try {
    cmsPaths = await listCmsPaths();
  } catch {
    return {
      plan: {
        routes: [],
        excluded: [],
        problems: [
          "The published CMS page list could not be read from the database, so the addresses to warm cannot be established.",
        ],
        notes: [],
      },
      cmsSnapshotAt,
      cmsPathsInSnapshot: 0,
    };
  }

  let configuredBookNowPath: string | null = null;
  try {
    configuredBookNowPath = await bookNowPagePath();
  } catch {
    // The button's own resolver already fails open, so a read failure here is not
    // a reason to refuse the deploy — but it IS a reason not to claim the public
    // booking entry was covered.
    configuredBookNowPath = null;
  }

  return {
    plan: buildWarmupPlan({
      table: table.table,
      cmsPaths,
      bookNowPagePath: configuredBookNowPath,
    }),
    cmsSnapshotAt,
    cmsPathsInSnapshot: cmsPaths.length,
  };
}

/**
 * Is the club's public website OPEN, or is it still behind the pre-setup holding
 * screen (#2420)?
 *
 * Load-bearing for the gate, and the case a first cut misses entirely: while
 * `ClubTheme.completedAt` is NULL every public address answers 503 with the "Site
 * setup in progress" document. A warm-up gate that did not know this would block
 * the very FIRST deploy of a new club for ever — there is no order of operations
 * that gets past it, because the operator completes setup through the deployed
 * site.
 *
 * So the state is read from the database, which is where the gate itself reads it,
 * rather than guessed from a 503 (an ordinary broken release also answers 503, and
 * the two must not be confused). Three answers, and each maps to a different
 * verdict:
 *  • complete — run the gate;
 *  • not complete — SKIP the gate, and say why in the report;
 *  • the read threw — BLOCK, because a release that cannot read `ClubTheme` cannot
 *    render a public page either.
 */
export async function readPublicSiteOpenState(): Promise<
  { state: "open" } | { state: "pre-setup" } | { state: "unknown" }
> {
  try {
    const theme = await getWebsiteThemeRenderState();
    if (theme.readFailed) {
      return { state: "unknown" };
    }
    return theme.isComplete ? { state: "open" } : { state: "pre-setup" };
  } catch {
    return { state: "unknown" };
  }
}

/**
 * Is the container that answered running the release this deploy is cutting over
 * to?
 *
 * The owner's decision asks for this "where possible, for example through a release
 * identifier or deployment header". The identifier is already in the image for a
 * different reason — `RELEASE_ID` (with `GIT_COMMIT_SHA` as the documented second
 * fallback) is what the fixed public-website CSP nonce is derived from, and the
 * `Dockerfile` promotes both into the runner's environment.
 *
 * The EXPECTED value arrives from the deploy script rather than the actual value
 * being returned to it. That direction is deliberate: the caller already knows
 * which commit it is deploying, so sending it costs nothing, and the release
 * identifier never has to be published in a response. Short forms appear in the
 * mismatch detail because a mismatch is useless without them.
 *
 * A prefix match counts (either direction, minimum seven characters), so an
 * operator who passes a short SHA gets a real check rather than a false mismatch.
 */
export function resolveReleaseIdentity(
  expected: string | null,
): ReleaseIdentityCheck {
  const actual =
    process.env.RELEASE_ID?.trim() ||
    process.env.GIT_COMMIT_SHA?.trim() ||
    null;

  if (!expected) {
    return { state: "not-checked" };
  }

  if (!actual) {
    return { state: "not-declared" };
  }

  const wanted = expected.trim().toLowerCase();
  const found = actual.toLowerCase();
  const shorter = wanted.length <= found.length ? wanted : found;
  const longer = wanted.length <= found.length ? found : wanted;

  if (shorter.length >= 7 && longer.startsWith(shorter)) {
    return { state: "match" };
  }

  return {
    state: "mismatch",
    detail: `expected release ${wanted.slice(0, 12)}, the container reports ${found.slice(0, 12)}`,
  };
}
