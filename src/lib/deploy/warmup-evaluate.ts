import type { WarmupRouteResult } from "@/lib/deploy/warmup-run";

/**
 * The tiered pass/block decision (#2566, owner decision Option 4).
 *
 * Pure, and separated from both discovery and the HTTP work, because this is the
 * part a reviewer must be able to read against the decision line by line. The
 * decision's rules, in its own terms:
 *
 *  • "Failure of any critical route must stop deployment before traffic cutover."
 *  • An isolated failure on a non-critical published CMS page may allow the deploy
 *    to continue only where all critical routes passed, discovery completed, cache
 *    storage works for the other routes, the failure is clearly isolated rather
 *    than systemic, the path and response are recorded prominently, and the
 *    failure is within tolerance.
 *  • Tolerance: "no more than one failed non-critical CMS route" AND "no more than
 *    10% of discovered non-critical CMS routes". "Both conditions must be met."
 *  • "Systemic cache or rendering failures block cutover."
 *
 * ## The arithmetic has a consequence worth saying out loud
 *
 * Because both conditions must hold, a club with fewer than ten published CMS
 * pages tolerates NO failures at all: one failure out of nine is 11%, which
 * exceeds the percentage even though it satisfies the count. That is the
 * conservative default the owner asked for rather than an oversight, and
 * `DEPLOYMENT.md` states it so an operator is never surprised by a blocked deploy
 * they expected to be tolerated.
 */

export interface WarmupTolerance {
  /** Absolute ceiling on failed non-critical CMS routes. */
  maxFailedCmsRoutes: number;
  /** Ceiling as a percentage of the discovered non-critical CMS routes. */
  maxFailedCmsPercent: number;
}

/** The owner's conservative default. Widening it is a deliberate, logged act. */
export const DEFAULT_WARMUP_TOLERANCE: WarmupTolerance = {
  maxFailedCmsRoutes: 1,
  maxFailedCmsPercent: 10,
};

/** Whether the release that answered is the release being deployed. */
export type ReleaseIdentityCheck =
  /** The target reported the release identifier the deploy expected. */
  | { state: "match" }
  /** It reported a different one: the wrong image, or the wrong container. */
  | { state: "mismatch"; detail: string }
  /** The image carries no release identifier (a bare local build). */
  | { state: "not-declared" }
  /** The deploy did not tell the gate what to expect. */
  | { state: "not-checked" };

export interface WarmupCounts {
  criticalDiscovered: number;
  criticalRendered: number;
  criticalCacheApplicable: number;
  criticalCacheVerified: number;
  /**
   * Critical addresses that turned out to be unpublished mid-run — in practice only
   * ever the promoted Book Now page target, since it is the one CMS page the plan
   * carries at critical tier. Counted separately so a critical route that rendered
   * fewer times than it was discovered has a stated reason instead of looking like a
   * defect in the gate.
   */
  criticalUnpublishedDuringWarmup: number;
  cmsDiscovered: number;
  cmsRendered: number;
  cmsCacheApplicable: number;
  cmsCacheVerified: number;
  cmsFailed: number;
  cmsUnpublishedDuringWarmup: number;
}

export type WarmupVerdict =
  "pass" | "pass-with-warning" | "blocked" | "skipped";

export interface WarmupEvaluation {
  verdict: WarmupVerdict;
  /** Every reason the cutover is blocked. Empty unless the verdict is `blocked`. */
  blockingReasons: readonly string[];
  /** Prominent but tolerable findings — including a permitted CMS failure. */
  warnings: readonly string[];
  /** Named systemic signals, whether or not they were the blocking reason. */
  systemicSignals: readonly string[];
  counts: WarmupCounts;
  tolerance: WarmupTolerance;
}

export interface WarmupEvaluationInput {
  /** Route-discovery failures. Any entry blocks. */
  discoveryProblems: readonly string[];
  /**
   * Discovery findings that do NOT block but must be prominent — something the gate
   * could not establish, as against something it established to be wrong. They join
   * {@link WarmupEvaluation.warnings} rather than the report's quiet notes list,
   * because "the booking entry could not be read" is not a note.
   */
  discoveryWarnings?: readonly string[];
  results: readonly WarmupRouteResult[];
  deadlineExpired: boolean;
  tolerance?: WarmupTolerance;
  releaseIdentity?: ReleaseIdentityCheck;
}

/**
 * The one place "is this route inside the tolerated tier?" is decided.
 *
 * Both the COUNTING and the EVALUATION read it, which is the point. They used to
 * disagree: counting bucketed everything non-critical into `cms*`, while the
 * tolerance check and the per-failure warnings filtered on `tier === "cms"`. With
 * two tier values those expressions agree, so no test could tell them apart — and
 * the day a third public tier appeared, a failure on it would have been counted and
 * then skipped by the tolerance arithmetic, giving a silent `pass` on a failed
 * public page.
 */
function isToleratedTier(result: WarmupRouteResult): boolean {
  return result.route.tier !== "critical";
}

/**
 * Failure kinds that are properties of the RELEASE rather than of one page, so a
 * single occurrence is systemic.
 *
 * Both are release-wide by construction: the fixed CSP nonce is one value for the
 * whole release (`src/lib/release-nonce.ts`), and whether a route group stores
 * pages is decided by the build. Seeing either on one address means it is true of
 * every address that shares the property.
 */
const SYSTEMIC_FAILURE_KINDS = new Set([
  "nonce-mismatch",
  "unexpected-cache-header",
]);

function describeFailure(result: WarmupRouteResult): string {
  const status =
    result.httpStatus === null ? "no response" : `HTTP ${result.httpStatus}`;
  const cache =
    result.cacheHeader === null
      ? "no cache indicator"
      : `cache ${result.cacheHeader}`;

  return `${result.route.path} — ${result.failure?.kind ?? "failed"}: ${result.failure?.detail ?? "no detail"} (${status}, ${cache})`;
}

export function countWarmupResults(
  results: readonly WarmupRouteResult[],
): WarmupCounts {
  const counts: WarmupCounts = {
    criticalDiscovered: 0,
    criticalRendered: 0,
    criticalCacheApplicable: 0,
    criticalCacheVerified: 0,
    criticalUnpublishedDuringWarmup: 0,
    cmsDiscovered: 0,
    cmsRendered: 0,
    cmsCacheApplicable: 0,
    cmsCacheVerified: 0,
    cmsFailed: 0,
    cmsUnpublishedDuringWarmup: 0,
  };

  for (const result of results) {
    if (!isToleratedTier(result)) {
      counts.criticalDiscovered += 1;
      if (result.rendered) counts.criticalRendered += 1;
      if (result.cacheApplicable) counts.criticalCacheApplicable += 1;
      if (result.cacheVerified) counts.criticalCacheVerified += 1;
      if (result.outcome === "unpublished-during-warmup") {
        counts.criticalUnpublishedDuringWarmup += 1;
      }
      continue;
    }

    counts.cmsDiscovered += 1;
    if (result.rendered) counts.cmsRendered += 1;
    if (result.cacheApplicable) counts.cmsCacheApplicable += 1;
    if (result.cacheVerified) counts.cmsCacheVerified += 1;
    if (result.outcome === "failed") counts.cmsFailed += 1;
    if (result.outcome === "unpublished-during-warmup") {
      counts.cmsUnpublishedDuringWarmup += 1;
    }
  }

  return counts;
}

/**
 * Applies the decision's rules to one instance's run.
 *
 * Fails closed everywhere the answer is unclear: an empty result set, a release
 * that did not identify itself as the one being deployed, a deadline that expired,
 * and a store that never confirmed a single page all block rather than pass.
 */
export function evaluateWarmup({
  discoveryProblems,
  discoveryWarnings = [],
  results,
  deadlineExpired,
  tolerance = DEFAULT_WARMUP_TOLERANCE,
  releaseIdentity = { state: "not-checked" },
}: WarmupEvaluationInput): WarmupEvaluation {
  const counts = countWarmupResults(results);
  const blockingReasons: string[] = [];
  const warnings: string[] = [];
  const systemicSignals: string[] = [];

  for (const problem of discoveryProblems) {
    blockingReasons.push(`Route discovery failed: ${problem}`);
  }

  for (const warning of discoveryWarnings) {
    warnings.push(`Route discovery: ${warning}`);
  }

  if (releaseIdentity.state === "mismatch") {
    systemicSignals.push(
      "the release that answered is not the release being deployed",
    );
    blockingReasons.push(
      `The target did not identify itself as the release being deployed: ${releaseIdentity.detail}. Warming the wrong container proves nothing about the one about to take traffic.`,
    );
  }

  if (releaseIdentity.state === "not-declared") {
    warnings.push(
      "The target image carries no release identifier, so the gate could not confirm the container it warmed is the release being deployed. Expected only for a locally built image; a registry deploy always carries one.",
    );
  }

  if (releaseIdentity.state === "not-checked") {
    warnings.push(
      "The deploy did not say which release to expect, so the gate could not confirm it warmed the intended one.",
    );
  }

  const criticalFailures = results.filter(
    (result) => result.route.tier === "critical" && result.outcome === "failed",
  );

  for (const failure of criticalFailures) {
    blockingReasons.push(`Critical route failed: ${describeFailure(failure)}`);
  }

  const criticalUnverified = results.filter(
    (result) =>
      result.route.tier === "critical" &&
      result.outcome === "warmed" &&
      result.cacheApplicable &&
      !result.cacheVerified,
  );

  for (const unverified of criticalUnverified) {
    blockingReasons.push(
      `Critical route ${unverified.route.path} rendered but was never confirmed as stored, so the first real visitor still pays a cold render.`,
    );
  }

  if (counts.criticalDiscovered === 0 && discoveryProblems.length === 0) {
    blockingReasons.push(
      "No critical public route was warmed, so the gate has established nothing about this release.",
    );
  }

  const cmsFailures = results.filter(
    (result) => isToleratedTier(result) && result.outcome === "failed",
  );

  const systemicKindFailures = results.filter((result) =>
    SYSTEMIC_FAILURE_KINDS.has(result.failure?.kind ?? ""),
  );
  for (const failure of systemicKindFailures) {
    systemicSignals.push(
      `${failure.failure?.kind} on ${failure.route.path} is a property of the whole release, not of one page`,
    );
  }

  if (counts.cmsCacheApplicable > 0 && counts.cmsCacheVerified === 0) {
    systemicSignals.push(
      `not one of the ${counts.cmsCacheApplicable} stored public pages could be confirmed as stored, so this release is not populating its page cache at all`,
    );
  }

  if (counts.cmsDiscovered > 0 && counts.cmsFailed === counts.cmsDiscovered) {
    systemicSignals.push(
      `every one of the ${counts.cmsDiscovered} published CMS pages failed, which is a release-wide fault rather than an isolated page`,
    );
  }

  if (deadlineExpired) {
    warnings.push(
      "The overall warm-up deadline expired before every address had been requested. Addresses that were never attempted are counted as failures.",
    );
  }

  if (
    tolerance.maxFailedCmsRoutes !==
      DEFAULT_WARMUP_TOLERANCE.maxFailedCmsRoutes ||
    tolerance.maxFailedCmsPercent !==
      DEFAULT_WARMUP_TOLERANCE.maxFailedCmsPercent
  ) {
    warnings.push(
      `The non-critical failure tolerance was widened for this deploy to ${tolerance.maxFailedCmsRoutes} route(s) and ${tolerance.maxFailedCmsPercent}% (default ${DEFAULT_WARMUP_TOLERANCE.maxFailedCmsRoutes} and ${DEFAULT_WARMUP_TOLERANCE.maxFailedCmsPercent}%). Deliberate widening is allowed; silent widening is not, so it is recorded here.`,
    );
  }

  const withinCount = counts.cmsFailed <= tolerance.maxFailedCmsRoutes;
  // Integer arithmetic rather than a float percentage, so the boundary is exact.
  const withinPercent =
    counts.cmsFailed * 100 <=
    tolerance.maxFailedCmsPercent * counts.cmsDiscovered;

  if (cmsFailures.length > 0) {
    for (const failure of cmsFailures) {
      warnings.push(`Published CMS page failed: ${describeFailure(failure)}`);
    }

    if (!withinCount || !withinPercent) {
      blockingReasons.push(
        `${counts.cmsFailed} of ${counts.cmsDiscovered} published CMS pages failed, which exceeds the tolerance of ${tolerance.maxFailedCmsRoutes} route(s) AND ${tolerance.maxFailedCmsPercent}% of those discovered (both must hold).`,
      );
    }
  }

  for (const signal of systemicSignals) {
    blockingReasons.push(`Systemic failure: ${signal}.`);
  }

  for (const result of results) {
    if (result.outcome !== "unpublished-during-warmup") {
      continue;
    }

    if (result.route.source === "book-now-target") {
      // The one case where the race lands on a CRITICAL address, and it is a real
      // thing for an admin to know rather than a technicality: the Book Now button
      // has silently fallen back to the member booking flow (the #1929 fail-open
      // contract requires `bookNowPage?.published`), so nothing public is broken and
      // the cutover proceeds — but the button no longer opens the page the club
      // chose, and only an admin can re-point it.
      warnings.push(
        `${result.route.path} is this club's configured Book Now target and was unpublished between discovery and warming. The 404 is correct and does not block the cutover, but the Book Now button has fallen back to the member booking flow — re-point or re-publish it in Admin > Page Content.`,
      );
      continue;
    }

    warnings.push(
      `${result.route.path} was unpublished between discovery and warming, so its 404 is the correct answer and is not counted as a failure.`,
    );
  }

  if (blockingReasons.length > 0) {
    return {
      verdict: "blocked",
      blockingReasons,
      warnings,
      systemicSignals,
      counts,
      tolerance,
    };
  }

  return {
    verdict: cmsFailures.length > 0 ? "pass-with-warning" : "pass",
    blockingReasons: [],
    warnings,
    systemicSignals,
    counts,
    tolerance,
  };
}
