import type {
  ExcludedWarmupPath,
  WarmupPlan,
} from "@/lib/deploy/warmup-route-policy";
import type {
  ReleaseIdentityCheck,
  WarmupCounts,
  WarmupEvaluation,
  WarmupTolerance,
  WarmupVerdict,
} from "@/lib/deploy/warmup-evaluate";
import type {
  WarmupRouteResult,
  WarmupRunReport,
} from "@/lib/deploy/warmup-run";

/**
 * The operator-facing warm-up summary (#2566).
 *
 * The owner's decision asks for "a concise final warm-up summary before cutover"
 * naming the target, the discovered/rendered/verified counts for both tiers, every
 * failed path with its HTTP result and cache-verification result, the total
 * duration and the verdict — and it is explicit that "Warnings must be prominent.
 * Do not bury failed routes in general deployment output."
 *
 * ## Two representations, one source
 *
 * The endpoint answers JSON by default (the house convention for a route handler,
 * and what the tests and any future tooling read) and plain text when the deploy
 * script asks for it. Both are rendered from the SAME report object, so the summary
 * an operator reads and the record a test asserts on cannot disagree.
 *
 * The last line of the text form is a machine-readable sentinel:
 *
 *     WARMUP-GATE-VERDICT: pass
 *
 * `scripts/run-production-blue-green-deploy.sh` requires that exact line with an
 * acceptable verdict before it will touch the Caddy upstream. Its absence — a
 * truncated response, a proxy error page, an unparseable body — blocks the cutover,
 * which is the fail-closed direction.
 */

export interface WarmupFailureSummary {
  path: string;
  tier: "critical" | "cms";
  kind: string;
  detail: string;
  /** The HTTP result for this failure, or null when nothing answered. */
  httpStatus: number | null;
  /** The cache-verification result, in the operator's words. */
  cacheVerification: string;
}

export interface WarmupGateReport {
  /** The verdict the deploy script gates on. */
  verdict: WarmupVerdict;
  /** Which web instance answered: `web-blue`, `web-green`, `cron-leader`. */
  serviceRole: string;
  /** Whether the release that answered is the one being deployed. */
  releaseIdentity: ReleaseIdentityCheck["state"];
  /** The production Host the warm-up rendered for. */
  publicHost: string;
  /** Where the requests went. Always this container's own loopback origin. */
  origin: string;
  /** When the published-CMS list was snapshotted for this run. */
  cmsSnapshotAt: string;
  counts: WarmupCounts;
  tolerance: WarmupTolerance;
  /** Total warm-up duration in milliseconds. */
  durationMs: number;
  /** Requests issued, retries and verification requests included. */
  requests: number;
  concurrencyLimit: number;
  peakConcurrency: number;
  failures: readonly WarmupFailureSummary[];
  excluded: readonly ExcludedWarmupPath[];
  notes: readonly string[];
  warnings: readonly string[];
  blockingReasons: readonly string[];
  /** Set only when the verdict is `skipped`. */
  skippedReason?: string;
}

export const WARMUP_VERDICT_SENTINEL = "WARMUP-GATE-VERDICT";

function cacheVerificationWord(result: WarmupRouteResult): string {
  if (!result.cacheApplicable) {
    return "not applicable (this release renders the address per request)";
  }

  if (result.cacheVerified) {
    return `confirmed stored (${result.cacheHeader ?? "prerendered"})`;
  }

  return `NOT confirmed stored (${result.cacheHeader ?? "no cache indicator"})`;
}

export function summariseFailures(
  results: readonly WarmupRouteResult[],
): WarmupFailureSummary[] {
  return results
    .filter((result) => result.outcome === "failed")
    .map((result) => ({
      path: result.route.path,
      tier: result.route.tier,
      kind: result.failure?.kind ?? "failed",
      detail: result.failure?.detail ?? "no detail recorded",
      httpStatus: result.httpStatus,
      cacheVerification: cacheVerificationWord(result),
    }));
}

export interface BuildWarmupReportInput {
  evaluation: WarmupEvaluation;
  plan: WarmupPlan;
  run: WarmupRunReport;
  serviceRole: string;
  releaseIdentity: ReleaseIdentityCheck;
  publicHost: string;
  origin: string;
  cmsSnapshotAt: string;
  concurrencyLimit: number;
}

export function buildWarmupReport({
  evaluation,
  plan,
  run,
  serviceRole,
  releaseIdentity,
  publicHost,
  origin,
  cmsSnapshotAt,
  concurrencyLimit,
}: BuildWarmupReportInput): WarmupGateReport {
  return {
    verdict: evaluation.verdict,
    serviceRole,
    releaseIdentity: releaseIdentity.state,
    publicHost,
    origin,
    cmsSnapshotAt,
    counts: evaluation.counts,
    tolerance: evaluation.tolerance,
    durationMs: run.durationMs,
    requests: run.results.reduce((total, result) => total + result.requests, 0),
    concurrencyLimit,
    peakConcurrency: run.peakConcurrency,
    failures: summariseFailures(run.results),
    excluded: plan.excluded,
    notes: plan.notes,
    warnings: evaluation.warnings,
    blockingReasons: evaluation.blockingReasons,
  };
}

/** A report for a run that never happened, with the reason. */
export function buildSkippedWarmupReport(
  reason: string,
  base: Pick<WarmupGateReport, "serviceRole" | "publicHost" | "origin"> & {
    tolerance: WarmupTolerance;
  },
): WarmupGateReport {
  return {
    verdict: "skipped",
    serviceRole: base.serviceRole,
    releaseIdentity: "not-checked",
    publicHost: base.publicHost,
    origin: base.origin,
    // Not an instant: this report describes a run that never took a snapshot, and
    // printing 1970-01-01 would read like a bug in the clock.
    cmsSnapshotAt: "not taken (the run did not start)",
    counts: {
      criticalDiscovered: 0,
      criticalRendered: 0,
      criticalCacheApplicable: 0,
      criticalCacheVerified: 0,
      cmsDiscovered: 0,
      cmsRendered: 0,
      cmsCacheApplicable: 0,
      cmsCacheVerified: 0,
      cmsFailed: 0,
      cmsUnpublishedDuringWarmup: 0,
    },
    tolerance: base.tolerance,
    durationMs: 0,
    requests: 0,
    concurrencyLimit: 0,
    peakConcurrency: 0,
    failures: [],
    excluded: [],
    notes: [],
    warnings: [],
    blockingReasons: [],
    skippedReason: reason,
  };
}

/** A report for a run that could not start, so the cutover must not proceed. */
export function buildBlockedWarmupReport(
  reason: string,
  base: Pick<WarmupGateReport, "serviceRole" | "publicHost" | "origin"> & {
    tolerance: WarmupTolerance;
  },
): WarmupGateReport {
  return {
    ...buildSkippedWarmupReport(reason, base),
    verdict: "blocked",
    blockingReasons: [reason],
    skippedReason: undefined,
  };
}

function formatSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function describeReleaseIdentity(state: ReleaseIdentityCheck["state"]): string {
  switch (state) {
    case "match":
      return "confirmed as the release being deployed";
    case "mismatch":
      return "DOES NOT MATCH the release being deployed";
    case "not-declared":
      return "the image carries no release identifier";
    default:
      return "not checked (the deploy did not say which release to expect)";
  }
}

function tierCountsLine(
  label: string,
  discovered: number,
  rendered: number,
  cacheApplicable: number,
  cacheVerified: number,
): string {
  const cachePart =
    cacheApplicable === 0
      ? "no stored pages among them"
      : `${cacheVerified} of ${cacheApplicable} confirmed stored`;

  return `  ${label.padEnd(22)}: ${discovered} discovered, ${rendered} rendered, ${cachePart}`;
}

/**
 * The plain-text summary the deploy script prints, ending in the verdict sentinel.
 *
 * Failures and warnings come FIRST among the detail blocks and are marked, because
 * the decision's requirement is that they are prominent rather than merely present.
 */
export function renderWarmupReportText(report: WarmupGateReport): string {
  const lines: string[] = [];

  lines.push("=====================================================");
  lines.push(`  Pre-cutover warm-up gate: ${report.serviceRole}`);
  lines.push("=====================================================");

  if (report.skippedReason) {
    lines.push(`  SKIPPED: ${report.skippedReason}`);
  }

  lines.push(
    `  target release        : ${describeReleaseIdentity(report.releaseIdentity)}`,
  );
  lines.push(`  rendered for host     : ${report.publicHost}`);
  lines.push(
    `  requests sent to      : ${report.origin} (this container only)`,
  );
  lines.push(`  CMS snapshot taken    : ${report.cmsSnapshotAt}`);
  lines.push(
    `  duration              : ${formatSeconds(report.durationMs)} over ${report.requests} request(s), at most ${report.peakConcurrency} at a time (limit ${report.concurrencyLimit})`,
  );
  lines.push(
    tierCountsLine(
      "critical routes",
      report.counts.criticalDiscovered,
      report.counts.criticalRendered,
      report.counts.criticalCacheApplicable,
      report.counts.criticalCacheVerified,
    ),
  );
  lines.push(
    tierCountsLine(
      "published CMS pages",
      report.counts.cmsDiscovered,
      report.counts.cmsRendered,
      report.counts.cmsCacheApplicable,
      report.counts.cmsCacheVerified,
    ),
  );
  lines.push(
    `  tolerance             : at most ${report.tolerance.maxFailedCmsRoutes} failed CMS page(s) AND at most ${report.tolerance.maxFailedCmsPercent}% of those discovered`,
  );

  if (report.counts.cmsUnpublishedDuringWarmup > 0) {
    lines.push(
      `  unpublished mid-run   : ${report.counts.cmsUnpublishedDuringWarmup} (not counted as failures)`,
    );
  }

  if (report.failures.length > 0) {
    lines.push("");
    lines.push(`  FAILED ROUTES (${report.failures.length}):`);
    for (const failure of report.failures) {
      lines.push(
        `    ! ${failure.path} [${failure.tier}] ${failure.kind} — ${failure.detail}`,
      );
      lines.push(
        `        HTTP: ${failure.httpStatus === null ? "no response" : failure.httpStatus}; cache: ${failure.cacheVerification}`,
      );
    }
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push(`  WARNINGS (${report.warnings.length}):`);
    for (const warning of report.warnings) {
      lines.push(`    ! ${warning}`);
    }
  }

  if (report.blockingReasons.length > 0) {
    lines.push("");
    lines.push("  CUTOVER BLOCKED:");
    for (const reason of report.blockingReasons) {
      lines.push(`    * ${reason}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push("");
    lines.push("  NOTES:");
    for (const note of report.notes) {
      lines.push(`    - ${note}`);
    }
  }

  if (report.excluded.length > 0) {
    lines.push("");
    lines.push(`  EXCLUDED ADDRESSES (${report.excluded.length}):`);
    for (const excluded of report.excluded) {
      lines.push(`    - ${excluded.path}: ${excluded.reason}`);
    }
  }

  lines.push("");
  lines.push(`${WARMUP_VERDICT_SENTINEL}: ${report.verdict}`);

  return `${lines.join("\n")}\n`;
}
