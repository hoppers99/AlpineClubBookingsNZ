// #2388 (built as part of MG3, #2308) — the three mitigations the owner decided
// on 31 Jul 2026, and the ONE property the owner was explicit about: repeated
// refusals are LOGGED for an admin and NEVER blocked.
//
// The last describe block in this file is the one that matters most. A member
// trying several dates to find one that suits a friend is the normal, innocent
// case; the owner rejected an automatic cap outright. So there is a test that
// runs a long refused sequence and asserts every answer stays byte-identical and
// that nothing anywhere branches on the repeat count.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createStructuredAuditLog: vi.fn(),
  auditLogCount: vi.fn(),
  applyMemberScopedRateLimit: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  createStructuredAuditLog: h.createStructuredAuditLog,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { count: h.auditLogCount } },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.loggerError },
}));
// `applyMemberScopedRateLimit` has its own tests in rate-limit.test.ts, where the
// two-key ordering is asserted against the real counter. Stubbing it here keeps
// this file about WHEN the throttle is consulted and what is done with its
// answer, which is the part #2388 actually decided.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  applyMemberScopedRateLimit: h.applyMemberScopedRateLimit,
}));

import {
  MEMBER_GUEST_REFUSAL_AUDIT_ACTION,
  MEMBER_GUEST_REFUSAL_FLOOR_MS,
  MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION,
  MEMBER_GUEST_REPEATED_REFUSAL_THRESHOLD,
  MEMBER_GUEST_REPEATED_REFUSAL_WINDOW_MS,
  __setMemberGuestRefusalFloorMs,
  applyMemberGuestAddThrottle,
  equaliseMemberGuestRefusalTiming,
  handleMemberGuestAddRefusal,
  memberGuestRefusalDelayMs,
  recordMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { rateLimiters } from "@/lib/rate-limit";

const request = () =>
  new Request("https://club.example/api/bookings/quote", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7" },
  });

const ALLOWED = null;
const DENIED = () =>
  new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 });

beforeEach(() => {
  vi.clearAllMocks();
  h.createStructuredAuditLog.mockResolvedValue(undefined);
  h.auditLogCount.mockResolvedValue(1);
  h.applyMemberScopedRateLimit.mockResolvedValue(ALLOWED);
  __setMemberGuestRefusalFloorMs(0);
});

afterEach(() => {
  __setMemberGuestRefusalFloorMs(MEMBER_GUEST_REFUSAL_FLOOR_MS);
});

describe("1. per-acting-member throttling on the add paths", () => {
  it("does nothing at all when the attempt names nobody beyond the family", async () => {
    const result = await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-booker",
      beyondFamilyMemberIds: [],
    });
    expect(result).toBeNull();
    // The property that keeps an ordinary family booking untouched: not merely
    // "allowed", but never counted at all, however many times the booker
    // changes their dates.
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
  });

  it("exempts an admin acting on behalf", async () => {
    const result = await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-officer",
      beyondFamilyMemberIds: ["m-stranger"],
      skipAuthorization: true,
    });
    expect(result).toBeNull();
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
  });

  it("throttles per ACTING MEMBER, through the member-scoped helper", async () => {
    await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-booker",
      beyondFamilyMemberIds: ["m-stranger"],
    });
    const actors = h.applyMemberScopedRateLimit.mock.calls.map((call) => call[2] as string);
    expect(actors).toEqual(["m-booker", "m-booker"]);
    const limiterIds = h.applyMemberScopedRateLimit.mock.calls.map(
      (call) => (call[0] as { id: string }).id,
    );
    // A burst window AND a daily backstop: the burst catches a script, the daily
    // is what actually defeats mapping a season.
    expect(limiterIds).toEqual([
      rateLimiters.memberGuestAddProbe.id,
      rateLimiters.memberGuestAddProbeDaily.id,
    ]);
  });

  it("returns a 429 when the burst budget is spent, without touching the daily one", async () => {
    h.applyMemberScopedRateLimit.mockResolvedValueOnce(DENIED());
    const result = await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-booker",
      beyondFamilyMemberIds: ["m-stranger"],
    });
    expect(result?.status).toBe(429);
    expect(h.applyMemberScopedRateLimit).toHaveBeenCalledTimes(1);
  });

  it("returns a 429 when only the daily backstop is spent", async () => {
    h.applyMemberScopedRateLimit
      .mockResolvedValueOnce(ALLOWED)
      .mockResolvedValueOnce(DENIED());
    const result = await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-booker",
      beyondFamilyMemberIds: ["m-stranger"],
    });
    expect(result?.status).toBe(429);
  });
});

describe("2. response-timing equalisation", () => {
  it("computes the remaining delay from the floor and the elapsed time", () => {
    __setMemberGuestRefusalFloorMs(250);
    expect(memberGuestRefusalDelayMs(0)).toBe(250);
    expect(memberGuestRefusalDelayMs(100)).toBe(150);
    // Never negative: a refusal that already took longer than the floor is not
    // hurried, and is not made to wait a second time.
    expect(memberGuestRefusalDelayMs(400)).toBe(0);
  });

  it("actually waits when the answer came back faster than the floor", async () => {
    __setMemberGuestRefusalFloorMs(60);
    // Two clocks on purpose: the helper is driven by the monotonic one it
    // actually uses, while the ASSERTION measures real elapsed time, so this
    // cannot pass by both sides sharing a broken clock.
    const clock = startMemberGuestRefusalClock();
    const wallBefore = Date.now();
    await equaliseMemberGuestRefusalTiming(clock);
    expect(Date.now() - wallBefore).toBeGreaterThanOrEqual(50);
  });

  it("does not wait at all when the answer already took longer than the floor", async () => {
    __setMemberGuestRefusalFloorMs(20);
    const clock = startMemberGuestRefusalClock() - 5_000;
    const wallBefore = Date.now();
    await equaliseMemberGuestRefusalTiming(clock);
    expect(Date.now() - wallBefore).toBeLessThan(20);
  });

  it("uses a MONOTONIC clock, so an NTP jump cannot skip or hang the floor", () => {
    // `Date.now()` is not a duration clock: a correction mid-request can make a
    // wall-clock delta negative (floor skipped) or enormous (response hangs).
    const a = startMemberGuestRefusalClock();
    const b = startMemberGuestRefusalClock();
    expect(b).toBeGreaterThanOrEqual(a);
    // And it is NOT epoch milliseconds — which is what stops anybody mistaking
    // it for a timestamp worth putting in an idempotency key.
    expect(a).toBeLessThan(Date.now() / 2);
  });
});

describe("3. logging repeated refusals — for an admin, NEVER a block", () => {
  it("writes one audit row per refused target, naming actor and subject", async () => {
    await recordMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      targetMemberIds: ["m-stranger", "m-other"],
      route: "bookings/quote",
    });

    const refusals = h.createStructuredAuditLog.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event.action === MEMBER_GUEST_REFUSAL_AUDIT_ACTION);
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatchObject({
      actor: { memberId: "m-booker" },
      subject: { memberId: "m-stranger" },
      category: "privacy",
      outcome: "failure",
      retentionClass: "sensitive_access",
    });
    expect(refusals[1]).toMatchObject({ subject: { memberId: "m-other" } });
  });

  it("raises a distinct, findable row once the same target is refused repeatedly", async () => {
    h.auditLogCount.mockResolvedValue(MEMBER_GUEST_REPEATED_REFUSAL_THRESHOLD);
    await recordMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      targetMemberIds: ["m-stranger"],
      route: "bookings/quote",
    });

    const warnings = h.createStructuredAuditLog.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event.action === MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      actor: { memberId: "m-booker" },
      subject: { memberId: "m-stranger" },
      severity: "important",
    });
    // The summary an admin reads has to say plainly that nothing was blocked,
    // or a club officer will assume the system already handled it.
    expect(String(warnings[0]!.summary)).toContain("nothing has been blocked");
  });

  it("counts only refusals by THIS actor against THIS target, inside the window", async () => {
    const now = new Date("2026-08-01T09:00:00.000Z");
    await recordMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      targetMemberIds: ["m-stranger"],
      route: "bookings/quote",
      now,
    });
    expect(h.auditLogCount).toHaveBeenCalledWith({
      where: {
        action: MEMBER_GUEST_REFUSAL_AUDIT_ACTION,
        actorMemberId: "m-booker",
        subjectMemberId: "m-stranger",
        createdAt: {
          gte: new Date(now.getTime() - MEMBER_GUEST_REPEATED_REFUSAL_WINDOW_MS),
        },
      },
    });
  });

  it("NEVER blocks an honest retry sequence — the owner's explicit sub-decision", async () => {
    // Twenty consecutive refusals naming the SAME member, far past the
    // threshold. This is the innocent case: somebody hunting for a date that
    // works for a friend. The property asserted is that the guard's answer never
    // changes — it has no return value to change, it raises no error, and the
    // caller's behaviour is identical on the twentieth attempt and the first.
    const attempts = 20;
    const outcomes: unknown[] = [];
    for (let i = 1; i <= attempts; i += 1) {
      h.auditLogCount.mockResolvedValue(i);
      outcomes.push(
        await recordMemberGuestAddRefusal({
          request: request(),
          actorMemberId: "m-booker",
          targetMemberIds: ["m-friend"],
          route: "bookings/quote",
        }),
      );
    }
    // Every call returned undefined — there is no signal a caller could act on.
    expect(outcomes.every((outcome) => outcome === undefined)).toBe(true);
    // And every attempt was recorded, including the ones past the threshold:
    // logging continues rather than degrading into a block.
    const refusals = h.createStructuredAuditLog.mock.calls.filter(
      (call) => (call[0] as { action: string }).action === MEMBER_GUEST_REFUSAL_AUDIT_ACTION,
    );
    expect(refusals).toHaveLength(attempts);
  });

  it("fails open — an audit outage cannot break a booking", async () => {
    h.createStructuredAuditLog.mockRejectedValue(new Error("audit store down"));
    await expect(
      recordMemberGuestAddRefusal({
        request: request(),
        actorMemberId: "m-booker",
        targetMemberIds: ["m-stranger"],
        route: "bookings/quote",
      }),
    ).resolves.toBeUndefined();
    expect(h.loggerError).toHaveBeenCalled();
  });
});

describe("handleMemberGuestAddRefusal — the one call every add path makes", () => {
  it("does nothing for an ordinary validation error", async () => {
    __setMemberGuestRefusalFloorMs(5_000);
    const before = Date.now();
    await handleMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      error: { message: "Check-out must be after check-in" } as {
        crossFamilyMemberIds?: readonly string[];
      },
      route: "bookings/quote",
      startedAt: startMemberGuestRefusalClock(),
    });
    // The floor must NOT be applied to ordinary errors: a quarter-second (here
    // five seconds) on "check-out must be after check-in" would slow the whole
    // booking flow down to hide nothing.
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(h.createStructuredAuditLog).not.toHaveBeenCalled();
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
  });

  it("spends the throttle budget, audits, and equalises for a collapsed refusal", async () => {
    __setMemberGuestRefusalFloorMs(40);
    const startedAt = startMemberGuestRefusalClock();
    const wallBefore = Date.now();
    await handleMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      error: { crossFamilyMemberIds: ["m-stranger"] },
      route: "bookings/quote",
      startedAt,
    });
    expect(h.applyMemberScopedRateLimit).toHaveBeenCalled();
    expect(h.createStructuredAuditLog).toHaveBeenCalled();
    expect(Date.now() - wallBefore).toBeGreaterThanOrEqual(30);
  });

  it("never converts a refusal into a 429, even when the budget is spent", async () => {
    // Returning a 429 only when the caller guessed a REAL member would be its
    // own oracle. The throttle's answer is deliberately discarded here.
    h.applyMemberScopedRateLimit.mockResolvedValue(DENIED());
    await expect(
      handleMemberGuestAddRefusal({
        request: request(),
        actorMemberId: "m-booker",
        error: { crossFamilyMemberIds: ["m-stranger"] },
        route: "bookings/quote",
        startedAt: startMemberGuestRefusalClock(),
      }),
    ).resolves.toBeUndefined();
  });
});
