/**
 * Which `CronJobRun` rows a cron-health view reads, and — the part that matters for
 * AI Diagnostics (#2375) — how many of those reads may be in flight at once.
 *
 * The selection itself is the older contract: the global recent window plus, per
 * expected job, its own recent history and its latest success and latest failure. What
 * these tests pin is the FAN-OUT. Three queries per job plus one global read is 103
 * statements at 34 tracked jobs, and issuing them through a single `Promise.all` put
 * 103 concurrent queries on the application pool per call. Survivable as an admin page
 * load; not survivable as a diagnostics tool, where a model may spend a whole
 * tool-call budget on job health and every expired executor deadline abandons its
 * queries without cancelling them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { cronJobRun: { findMany: vi.fn() } },
}));

import type { AdminCronJobDefinition } from "@/lib/admin-cron-health";
import {
  CRON_RUN_FANOUT_CONCURRENCY,
  CronRunReadDeadlineError,
  getCronRunsForAdminHealth,
} from "@/lib/admin-cron-runs";
import { prisma } from "@/lib/prisma";

const findManyMock = vi.mocked(prisma.cronJobRun.findMany);

/** Twelve tracked jobs: enough to need several batches at any sane width. */
const DEFINITIONS = Array.from({ length: 12 }, (_unused, index) => ({
  jobName: `job-${String(index).padStart(2, "0")}`,
  recordsRuns: true,
})) as unknown as AdminCronJobDefinition[];

/**
 * A `findMany` that reports the peak number of calls in flight. Every call settles on a
 * later microtask, so a batched implementation cannot accidentally look bounded merely
 * because the mock resolved synchronously.
 */
function trackingFindMany() {
  let inFlight = 0;
  let peak = 0;
  findManyMock.mockImplementation((async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    await Promise.resolve();
    inFlight -= 1;
    return [];
  }) as never);
  return () => peak;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCronRunsForAdminHealth fan-out (#2375)", () => {
  it("keeps concurrent reads inside the declared batch width", async () => {
    const peak = trackingFindMany();
    await getCronRunsForAdminHealth(DEFINITIONS);

    // Three queries per job in a batch, and never more than one batch at a time. The
    // global recent-runs read is awaited before the batches begin, so it cannot add to
    // the peak either.
    expect(peak()).toBeLessThanOrEqual(CRON_RUN_FANOUT_CONCURRENCY * 3);
    // Every read still happens: bounding the concurrency must not drop a job, or the
    // classifier would report a live job as `missing`.
    expect(findManyMock).toHaveBeenCalledTimes(1 + DEFINITIONS.length * 3);
  });

  it("honours a narrower width, so a caller can trade latency for pool pressure", async () => {
    const peak = trackingFindMany();
    await getCronRunsForAdminHealth(DEFINITIONS, { concurrency: 1 });
    expect(peak()).toBeLessThanOrEqual(3);
    expect(findManyMock).toHaveBeenCalledTimes(1 + DEFINITIONS.length * 3);
  });

  it("REFUSES on an expired deadline rather than returning fewer runs", async () => {
    // The honesty requirement. A partial run set is not a smaller answer, it is a WRONG
    // one: `buildCronHealthReport` classifies a job with no rows as `missing`, so
    // dropping reads would fabricate failures for jobs that are running fine. The
    // Diagnostics executor turns this rejection into `evidence_unavailable` and no rows.
    findManyMock.mockResolvedValue([] as never);
    await expect(
      getCronRunsForAdminHealth(DEFINITIONS, { deadlineAtMs: Date.now() - 1 }),
    ).rejects.toThrow(CronRunReadDeadlineError);
    // Refused BEFORE issuing anything: an expired deadline must stop the work, not just
    // stop us waiting for work already sent.
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("stops issuing batches once the deadline passes mid-read", async () => {
    findManyMock.mockResolvedValue([] as never);
    // A deadline that has not passed when the first check runs but has by the second.
    const nowSpy = vi.spyOn(Date, "now");
    let ticks = 0;
    nowSpy.mockImplementation(() => {
      ticks += 1;
      return ticks <= 2 ? 1_000 : 9_999;
    });
    try {
      await expect(
        getCronRunsForAdminHealth(DEFINITIONS, { deadlineAtMs: 5_000 }),
      ).rejects.toThrow(CronRunReadDeadlineError);
    } finally {
      nowSpy.mockRestore();
    }
    // It got started, and it stopped early rather than draining all twelve jobs.
    expect(findManyMock.mock.calls.length).toBeLessThan(1 + DEFINITIONS.length * 3);
  });

  it("issues nothing per-job when no definition records runs", async () => {
    findManyMock.mockResolvedValue([] as never);
    await getCronRunsForAdminHealth([
      { jobName: "untracked", recordsRuns: false },
    ] as unknown as AdminCronJobDefinition[]);
    // Only the global recent-runs read.
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });
});
