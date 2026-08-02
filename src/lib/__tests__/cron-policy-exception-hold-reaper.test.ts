import { beforeEach, describe, expect, it, vi } from "vitest";

// #2553: the abandoned policy-exception capacity-hold reaper. These tests pin
// the three properties the issue turns on — the scan only ever sees holds, the
// deadline decides, and the release is the SHARED atomic terminal transition
// (never a forked delete) — plus idempotency across reruns and races.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  resolveTerminal: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingChangeRequest: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
    },
  },
}));

vi.mock("@/lib/booking-exception-execution", () => ({
  resolvePolicyExceptionRequestTerminal: (...a: unknown[]) =>
    mocks.resolveTerminal(...a),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { reapExpiredPolicyExceptionHolds } from "@/lib/cron-policy-exception-hold-reaper";
import {
  computePolicyExceptionHoldExpiry,
  POLICY_EXCEPTION_HOLD_TTL_DAYS,
} from "@/lib/booking-exception-requests";

// The suite runs under the repo's frozen clock (2026-07-01T00:00:00.000Z), so
// every fixture below is written relative to that instant.
const NOW = new Date("2026-07-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function candidate(
  over: Partial<{
    id: string;
    version: number;
    holdExpiresAt: Date | null;
    createdAt: Date;
  }> = {},
) {
  return {
    id: "req-1",
    version: 3,
    holdExpiresAt: new Date(NOW.getTime() - 60_000),
    createdAt: new Date(NOW.getTime() - 8 * DAY_MS),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTerminal.mockResolvedValue({ claimed: true, released: 2 });
});

describe("reapExpiredPolicyExceptionHolds", () => {
  it("scans only OPEN, HOLD-mode policy-exception requests that still hold beds", async () => {
    mocks.findMany.mockResolvedValue([]);

    await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      kind: "POLICY_EXCEPTION",
      // An officer-decided, member-cancelled, superseded or already-expired row
      // is out of scope: only a request still awaiting a decision can be
      // abandoned, and only through this filter can the cron be idempotent.
      status: "REQUESTED",
      aggregateCapacityMode: "HOLD",
      // The invariant that keeps the blast radius to stranded capacity: a HOLD
      // request whose incremental footprint came out empty (a pure shrink) holds
      // no beds, so this cron must never close it. Reservation rows exist only
      // between creation and a terminal transition, so for a REQUESTED row this
      // is exactly "is stranding beds right now".
      reservationNights: { some: {} },
    });
  });

  it("never sees a NO_HOLD or empty-footprint request, so cannot close one", async () => {
    // Belt-and-braces on the filter above: the where clause is the ONLY thing
    // deciding which requests are in scope, so pin that a request outside it is
    // never even a candidate — the cron cannot reach `resolveTerminal` for it.
    mocks.findMany.mockResolvedValue([]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
    expect(result).toEqual({
      scanned: 0,
      expired: 0,
      releasedNights: 0,
      failed: 0,
    });
  });

  it("expires a past-deadline hold through the SHARED terminal release", async () => {
    mocks.findMany.mockResolvedValue([candidate()]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.resolveTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTerminal).toHaveBeenCalledWith({
      requestId: "req-1",
      // The version read during the scan is the optimistic claim token, so a
      // decision landing in between makes this a lost claim rather than a
      // clobber.
      expectedVersion: 3,
      to: "EXPIRED",
    });
    expect(result).toEqual({
      scanned: 1,
      expired: 1,
      releasedNights: 2,
      failed: 0,
    });
  });

  it("leaves a hold whose deadline has not arrived completely alone", async () => {
    mocks.findMany.mockResolvedValue([
      candidate({ holdExpiresAt: new Date(NOW.getTime() + 60_000) }),
    ]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
    expect(result).toEqual({
      scanned: 1,
      expired: 0,
      releasedNights: 0,
      failed: 0,
    });
  });

  it("treats a deadline exactly at `now` as due", async () => {
    mocks.findMany.mockResolvedValue([
      candidate({ holdExpiresAt: new Date(NOW.getTime()) }),
    ]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result.expired).toBe(1);
  });

  it("falls back to the createdAt-derived deadline when the column is NULL", async () => {
    // A HOLD request the OLD colour wrote during the migrate -> cutover drain
    // has no stored deadline; without the fallback it would hold its beds
    // forever, which is exactly the bug this cron exists to close.
    const createdAt = new Date(
      NOW.getTime() - (POLICY_EXCEPTION_HOLD_TTL_DAYS + 1) * DAY_MS,
    );
    mocks.findMany.mockResolvedValue([
      candidate({ holdExpiresAt: null, createdAt }),
    ]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result.expired).toBe(1);
    // ...and the same fallback keeps a RECENT null-column hold alive.
    mocks.resolveTerminal.mockClear();
    mocks.findMany.mockResolvedValue([
      candidate({ holdExpiresAt: null, createdAt: new Date(NOW.getTime() - DAY_MS) }),
    ]);
    const recent = await reapExpiredPolicyExceptionHolds(NOW);
    expect(recent.expired).toBe(0);
    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
  });

  it("reports nothing when the guarded claim is lost to a real decision", async () => {
    mocks.findMany.mockResolvedValue([candidate()]);
    mocks.resolveTerminal.mockResolvedValue({ claimed: false, released: 0 });

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result).toEqual({
      scanned: 1,
      expired: 0,
      releasedNights: 0,
      failed: 0,
    });
  });

  it("is idempotent across reruns: an already-expired request is no longer scanned", async () => {
    mocks.findMany.mockResolvedValueOnce([candidate()]);
    const first = await reapExpiredPolicyExceptionHolds(NOW);
    expect(first.expired).toBe(1);

    // The status filter excludes the EXPIRED row on the next run, so the second
    // pass claims nothing and releases nothing.
    mocks.findMany.mockResolvedValueOnce([]);
    const second = await reapExpiredPolicyExceptionHolds(NOW);
    expect(second).toEqual({
      scanned: 0,
      expired: 0,
      releasedNights: 0,
      failed: 0,
    });
    expect(mocks.resolveTerminal).toHaveBeenCalledTimes(1);
  });

  it("two runners racing the SAME hold expire it exactly once, releasing its beds once", async () => {
    // Concurrent-run safety without an extra job-level advisory lock: the shared
    // terminal helper claims on `status = REQUESTED` AND the exact version read
    // during the scan, inside the global -> lodge locks. Model that here with one
    // claim latch — the first claim through wins, every later one is a lost claim
    // that releases nothing. This is what makes overlapping cron cycles (a slow
    // run still going when the next fires) safe: beds are returned to the pool
    // once, never twice, and capacity can never be double-credited.
    mocks.findMany.mockResolvedValue([candidate()]);
    const claimed = new Set<string>();
    mocks.resolveTerminal.mockImplementation(
      async ({
        requestId,
        expectedVersion,
      }: {
        requestId: string;
        expectedVersion: number;
      }) => {
        const key = `${requestId}@${expectedVersion}`;
        if (claimed.has(key)) return { claimed: false, released: 0 };
        claimed.add(key);
        return { claimed: true, released: 2 };
      },
    );

    const [runA, runB] = await Promise.all([
      reapExpiredPolicyExceptionHolds(NOW),
      reapExpiredPolicyExceptionHolds(NOW),
    ]);

    expect(runA.expired + runB.expired).toBe(1);
    expect(runA.releasedNights + runB.releasedNights).toBe(2);
    expect(runA.failed + runB.failed).toBe(0);
  });

  it("keeps going after one request throws, counting it as failed", async () => {
    mocks.findMany.mockResolvedValue([
      candidate({ id: "req-boom" }),
      candidate({ id: "req-ok", version: 9 }),
    ]);
    mocks.resolveTerminal.mockImplementation(
      async ({ requestId }: { requestId: string }) => {
        if (requestId === "req-boom") throw new Error("deadlock detected");
        return { claimed: true, released: 1 };
      },
    );

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result).toEqual({
      scanned: 2,
      expired: 1,
      releasedNights: 1,
      failed: 1,
    });
  });
});

describe("computePolicyExceptionHoldExpiry", () => {
  it("defaults to the TTL window from creation", async () => {
    const createdAt = new Date("2026-07-01T09:00:00.000Z");
    expect(
      computePolicyExceptionHoldExpiry({ createdAt }).getTime(),
    ).toBe(createdAt.getTime() + POLICY_EXCEPTION_HOLD_TTL_DAYS * DAY_MS);
  });

  it("never outlives the start of the first held night", async () => {
    const createdAt = new Date("2026-07-01T09:00:00.000Z");
    const expiry = computePolicyExceptionHoldExpiry({
      createdAt,
      // Two days out — well inside the 7-day TTL, so the night caps it.
      firstHeldNight: "2026-07-03",
    });
    expect(expiry.getTime()).toBeLessThan(
      createdAt.getTime() + POLICY_EXCEPTION_HOLD_TTL_DAYS * DAY_MS,
    );
    // 2026-07-03 00:00 in Pacific/Auckland (NZST, UTC+12) is 2026-07-02T12:00Z.
    expect(expiry.toISOString()).toBe("2026-07-02T12:00:00.000Z");
  });

  it("still gives a last-minute request its minimum review window", async () => {
    const createdAt = new Date("2026-07-01T09:00:00.000Z");
    // The first held night has already started, so the cap alone would put the
    // deadline in the past and the very next cron run would reap a request
    // nobody has looked at.
    const expiry = computePolicyExceptionHoldExpiry({
      createdAt,
      firstHeldNight: "2026-06-30",
    });
    expect(expiry.getTime()).toBe(createdAt.getTime() + DAY_MS);
  });

  it("ignores an unparseable night rather than producing an invalid deadline", async () => {
    const createdAt = new Date("2026-07-01T09:00:00.000Z");
    const expiry = computePolicyExceptionHoldExpiry({
      createdAt,
      firstHeldNight: "not-a-date",
    });
    expect(Number.isNaN(expiry.getTime())).toBe(false);
    expect(expiry.getTime()).toBe(
      createdAt.getTime() + POLICY_EXCEPTION_HOLD_TTL_DAYS * DAY_MS,
    );
  });
});
