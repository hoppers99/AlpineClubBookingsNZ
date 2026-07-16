import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberGroupingResolution } from "@/lib/xero-member-grouping";

const mocks = vi.hoisted(() => ({
  cursorFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  membershipCacheFindMany: vi.fn(),
  loadXeroGroupingContext: vi.fn(),
  resolveMemberGroupingsForMembers: vi.fn(),
  syncManagedXeroContactGroupForMember: vi.fn(),
  dryRunFindUnique: vi.fn(),
  dryRunCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncCursor: { findUnique: mocks.cursorFindUnique },
    member: { findMany: mocks.memberFindMany },
    xeroContactGroupMembershipCache: { findMany: mocks.membershipCacheFindMany },
    xeroMemberGroupingDryRun: {
      findUnique: mocks.dryRunFindUnique,
      create: mocks.dryRunCreate,
    },
  },
}));

vi.mock("@/lib/xero-member-grouping", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/xero-member-grouping")>();
  return {
    ...actual,
    loadXeroGroupingContext: mocks.loadXeroGroupingContext,
    resolveMemberGroupingsForMembers: mocks.resolveMemberGroupingsForMembers,
  };
});

vi.mock("@/lib/xero-contact-groups", () => ({
  syncManagedXeroContactGroupForMember: mocks.syncManagedXeroContactGroupForMember,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  getXeroMemberGroupingSnapshot,
  recordXeroMemberGroupingDryRun,
  runXeroMemberGroupingBulkResyncChunk,
  StaleDryRunError,
  type MemberGroupingSnapshot,
} from "@/lib/xero-member-grouping-resync";
import { XeroDailyLimitError } from "@/lib/xero-api-client";

/**
 * Build a persisted-dry-run record (as prisma.xeroMemberGroupingDryRun.findUnique
 * returns) that is FRESH relative to a given snapshot: same cache cursor, same
 * rules fingerprint, same planned digest, recorded just now. Tests override one
 * field at a time to exercise each rejection.
 */
function freshRecordFor(
  snapshot: MemberGroupingSnapshot,
  overrides: Partial<{
    createdAt: Date;
    cacheCursorAt: Date;
    rulesFingerprint: string;
    plannedDigest: string;
  }> = {},
) {
  return {
    createdAt: new Date(),
    cacheCursorAt: snapshot.lastRefreshedAt
      ? new Date(snapshot.lastRefreshedAt)
      : new Date(),
    rulesFingerprint: snapshot.rulesFingerprint,
    plannedDigest: snapshot.plannedDigest,
    ...overrides,
  };
}

const adultResolution: MemberGroupingResolution = {
  mode: "MEMBERSHIP_TYPE_AND_AGE",
  managedGroup: { id: "g_adult", name: "Adults" },
  acceptedGroupIds: ["g_adult"],
  managedUniverse: ["g_adult", "g_youth"],
  skippedReason: null,
};

// A parked member: no rule matches (e.g. NOT_APPLICABLE organisation), so the
// sync never writes — but the managed universe is still known.
const parkedResolution: MemberGroupingResolution = {
  mode: "MEMBERSHIP_TYPE_AND_AGE",
  managedGroup: null,
  acceptedGroupIds: [],
  managedUniverse: ["g_adult", "g_youth"],
  skippedReason: "no_matching_rule",
};

function seedTwoMismatchesOneCorrectOneNoContact() {
  mocks.loadXeroGroupingContext.mockResolvedValue({
    mode: "MEMBERSHIP_TYPE_AND_AGE",
    activeRules: [],
  });
  mocks.cursorFindUnique.mockResolvedValue({ lastSuccessfulSyncAt: new Date("2026-07-16T00:00:00Z") });
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", lastName: "A", email: "a@x", ageTier: "ADULT", xeroContactId: "c1" },
    { id: "m2", firstName: "B", lastName: "B", email: "b@x", ageTier: "ADULT", xeroContactId: "c2" },
    { id: "m3", firstName: "C", lastName: "C", email: "c@x", ageTier: "ADULT", xeroContactId: "c3" },
    { id: "m4", firstName: "D", lastName: "D", email: "d@x", ageTier: "ADULT", xeroContactId: null },
    // Parked: no matching rule, sitting in a MANAGED group -> information only.
    { id: "m5", firstName: "E", lastName: "E", email: "e@x", ageTier: "NOT_APPLICABLE", xeroContactId: "c5" },
    // Parked: no matching rule, only in an unmanaged group -> invisible.
    { id: "m6", firstName: "F", lastName: "F", email: "f@x", ageTier: "NOT_APPLICABLE", xeroContactId: "c6" },
  ]);
  // c1, c3 are mis-grouped (in youth); c2 is correct (in adult).
  mocks.membershipCacheFindMany.mockResolvedValue([
    { contactId: "c1", contactGroupId: "g_youth" },
    { contactId: "c2", contactGroupId: "g_adult" },
    { contactId: "c3", contactGroupId: "g_youth" },
    { contactId: "c5", contactGroupId: "g_adult" },
    { contactId: "c5", contactGroupId: "g_unrelated" },
    { contactId: "c6", contactGroupId: "g_unrelated" },
  ]);
  mocks.resolveMemberGroupingsForMembers.mockResolvedValue(
    new Map([
      ["m1", adultResolution],
      ["m2", adultResolution],
      ["m3", adultResolution],
      ["m5", parkedResolution],
      ["m6", parkedResolution],
    ]),
  );
}

describe("getXeroMemberGroupingSnapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports cacheReady=false when the cache has never refreshed", async () => {
    mocks.loadXeroGroupingContext.mockResolvedValue({ mode: "MEMBERSHIP_TYPE_AND_AGE", activeRules: [] });
    mocks.cursorFindUnique.mockResolvedValue(null);
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.cacheReady).toBe(false);
    expect(snap.mismatchCount).toBe(0);
  });

  it("is an empty diff under NONE mode (never touches Xero)", async () => {
    mocks.loadXeroGroupingContext.mockResolvedValue({ mode: "NONE", activeRules: [] });
    mocks.cursorFindUnique.mockResolvedValue({ lastSuccessfulSyncAt: new Date() });
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.mode).toBe("NONE");
    expect(snap.mismatchCount).toBe(0);
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });

  it("flags mismatched members, lists no-contact members as skipped, and estimates calls", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.mismatchCount).toBe(2);
    expect(snap.addCount).toBe(2);
    expect(snap.removeCount).toBe(2);
    expect(snap.skippedNoContact).toEqual([{ memberId: "m4", memberName: "D D" }]);
    // per mismatch: getContact + add + remove + refresh = 4; x2 = 8.
    // Information-only entries cost zero calls.
    expect(snap.estimatedXeroCalls).toBe(8);
    const ids = snap.mismatches.map((m) => m.memberId).sort();
    expect(ids).toEqual(["m1", "m3"]);
  });

  it("reads staleness from the CONTACT_GROUP_FULL_REFRESH cursor, not the per-contact cache cursor", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.lastRefreshedAt).toBe("2026-07-16T00:00:00.000Z");
    expect(mocks.cursorFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          resourceType_scope: {
            resourceType: "CONTACT_GROUP_FULL_REFRESH",
            scope: "default",
          },
        },
      }),
    );
  });

  it("surfaces parked members in managed groups as information-only entries (no add/remove)", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.informationalCount).toBe(1);
    expect(snap.informational).toEqual([
      {
        memberId: "m5",
        memberName: "E E",
        memberEmail: "e@x",
        ageTier: "NOT_APPLICABLE",
        xeroContactId: "c5",
        // Only the managed-universe intersection — g_unrelated is not listed.
        unexpectedManagedGroupIds: ["g_adult"],
      },
    ]);
    // Never in the actionable mismatch list...
    expect(snap.mismatches.map((m) => m.memberId)).not.toContain("m5");
    // ...and a parked member outside the managed universe is invisible.
    expect(snap.informational.map((m) => m.memberId)).not.toContain("m6");
  });
});

describe("runXeroMemberGroupingBulkResyncChunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncManagedXeroContactGroupForMember.mockResolvedValue({
      addedGroupIds: ["g_adult"],
      removedGroupIds: ["g_youth"],
    });
  });

  // Prime prisma.xeroMemberGroupingDryRun.findUnique with a record that is fresh
  // relative to the seeded snapshot (same cursor + rules + planned digest).
  async function primeFreshDryRun(
    overrides?: Parameters<typeof freshRecordFor>[1],
  ): Promise<MemberGroupingSnapshot> {
    const snap = await getXeroMemberGroupingSnapshot();
    mocks.dryRunFindUnique.mockResolvedValue(freshRecordFor(snap, overrides));
    return snap;
  }

  it("is a no-op under NONE mode (short-circuits before the freshness check)", async () => {
    mocks.loadXeroGroupingContext.mockResolvedValue({ mode: "NONE", activeRules: [] });
    const res = await runXeroMemberGroupingBulkResyncChunk({ dryRunId: "dr1" });
    expect(res.done).toBe(true);
    expect(res.processed).toBe(0);
    expect(mocks.syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
    // NONE never even looks the dry-run up.
    expect(mocks.dryRunFindUnique).not.toHaveBeenCalled();
  });

  it("accepts a fresh dry-run and only touches mismatched members (never the correct or parked ones)", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    await primeFreshDryRun();
    const res = await runXeroMemberGroupingBulkResyncChunk({ dryRunId: "dr1" });
    expect(res.processed).toBe(2);
    expect(res.added).toBe(2);
    expect(res.removed).toBe(2);
    expect(res.done).toBe(true);
    const calledIds = mocks.syncManagedXeroContactGroupForMember.mock.calls.map((c) => c[0]).sort();
    expect(calledIds).toEqual(["m1", "m3"]);
    expect(calledIds).not.toContain("m2");
    // m5 is information-only (parked in a managed group): bulk never writes it.
    expect(calledIds).not.toContain("m5");
  });

  it("chunks and resumes via the member-id cursor", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    await primeFreshDryRun();
    const first = await runXeroMemberGroupingBulkResyncChunk({ dryRunId: "dr1", limit: 1 });
    expect(first.processed).toBe(1);
    expect(first.done).toBe(false);
    expect(first.nextCursorMemberId).toBe("m1");

    const second = await runXeroMemberGroupingBulkResyncChunk({
      dryRunId: "dr1",
      limit: 1,
      afterMemberId: first.nextCursorMemberId!,
    });
    expect(second.processed).toBe(1);
    expect(second.done).toBe(true);
    expect(second.nextCursorMemberId).toBeNull();
    expect(mocks.syncManagedXeroContactGroupForMember).toHaveBeenLastCalledWith("m3", expect.anything());
  });

  it("records per-member failures and continues (non-fatal)", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    await primeFreshDryRun();
    mocks.syncManagedXeroContactGroupForMember
      .mockRejectedValueOnce(new Error("xero boom"))
      .mockResolvedValueOnce({ addedGroupIds: ["g_adult"], removedGroupIds: [] });
    const res = await runXeroMemberGroupingBulkResyncChunk({ dryRunId: "dr1" });
    expect(res.failed).toBe(1);
    expect(res.failures[0].memberId).toBe("m1");
    expect(res.processed).toBe(1);
    expect(res.done).toBe(true);
  });

  it("halts on a Xero daily limit and leaves a resume cursor", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    await primeFreshDryRun();
    mocks.syncManagedXeroContactGroupForMember
      .mockResolvedValueOnce({ addedGroupIds: ["g_adult"], removedGroupIds: ["g_youth"] })
      .mockRejectedValueOnce(new XeroDailyLimitError(3600));
    const res = await runXeroMemberGroupingBulkResyncChunk({ dryRunId: "dr1" });
    expect(res.haltedByDailyLimit).toBe(true);
    expect(res.done).toBe(false);
    expect(res.nextCursorMemberId).toBe("m1");
    expect(res.processed).toBe(1);
  });
});

describe("runXeroMemberGroupingBulkResyncChunk — server-side dry-run freshness (#1961)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncManagedXeroContactGroupForMember.mockResolvedValue({
      addedGroupIds: ["g_adult"],
      removedGroupIds: ["g_youth"],
    });
    seedTwoMismatchesOneCorrectOneNoContact();
  });

  async function currentSnapshot(): Promise<MemberGroupingSnapshot> {
    return getXeroMemberGroupingSnapshot();
  }

  function expectReject(reason: string) {
    return async () => {
      await expect(
        runXeroMemberGroupingBulkResyncChunk({ dryRunId: "dr1" }),
      ).rejects.toMatchObject({ name: "StaleDryRunError", reason });
      expect(mocks.syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
    };
  }

  it("rejects when the referenced dry-run does not exist (not_found)", async () => {
    mocks.dryRunFindUnique.mockResolvedValue(null);
    await expectReject("not_found")();
  });

  it("rejects when the group cache was refreshed since the dry-run (cache_cursor_changed)", async () => {
    const snap = await currentSnapshot();
    mocks.dryRunFindUnique.mockResolvedValue(
      freshRecordFor(snap, { cacheCursorAt: new Date("2020-01-01T00:00:00Z") }),
    );
    await expectReject("cache_cursor_changed")();
  });

  it("rejects when a rule or the mode changed since the dry-run (rules_changed)", async () => {
    const snap = await currentSnapshot();
    mocks.dryRunFindUnique.mockResolvedValue(
      freshRecordFor(snap, { rulesFingerprint: "stale-fingerprint" }),
    );
    await expectReject("rules_changed")();
  });

  it("rejects an initiating run when the dry-run is older than the freshness window (expired)", async () => {
    const snap = await currentSnapshot();
    mocks.dryRunFindUnique.mockResolvedValue(
      freshRecordFor(snap, {
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    );
    await expectReject("expired")();
  });

  it("rejects an initiating run when the planned changes drifted from the reviewed diff (plan_changed)", async () => {
    const snap = await currentSnapshot();
    mocks.dryRunFindUnique.mockResolvedValue(
      freshRecordFor(snap, { plannedDigest: "stale-digest" }),
    );
    await expectReject("plan_changed")();
  });

  it("skips the wall-clock window and plan-digest checks on resume, but still enforces cursor + rules", async () => {
    const snap = await currentSnapshot();
    // An old, plan-drifted record: on a RESUME (afterMemberId present) only the
    // cursor + rules equality matter, so this run proceeds.
    mocks.dryRunFindUnique.mockResolvedValue(
      freshRecordFor(snap, {
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        plannedDigest: "stale-digest",
      }),
    );
    const resumed = await runXeroMemberGroupingBulkResyncChunk({
      dryRunId: "dr1",
      afterMemberId: "m1",
    });
    expect(resumed.processed).toBe(1);
    expect(mocks.syncManagedXeroContactGroupForMember).toHaveBeenCalledWith(
      "m3",
      expect.anything(),
    );

    // ...but a cursor change still aborts even a resume.
    vi.clearAllMocks();
    seedTwoMismatchesOneCorrectOneNoContact();
    const snap2 = await currentSnapshot();
    mocks.dryRunFindUnique.mockResolvedValue(
      freshRecordFor(snap2, { cacheCursorAt: new Date("2020-01-01T00:00:00Z") }),
    );
    await expect(
      runXeroMemberGroupingBulkResyncChunk({ dryRunId: "dr1", afterMemberId: "m1" }),
    ).rejects.toBeInstanceOf(StaleDryRunError);
  });
});

describe("recordXeroMemberGroupingDryRun (#1961)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedTwoMismatchesOneCorrectOneNoContact();
    mocks.dryRunCreate.mockResolvedValue({ id: "dr_persisted" });
  });

  it("persists provenance (cursor + fingerprint + digest + counts) and returns the id", async () => {
    const { snapshot, dryRunId } = await recordXeroMemberGroupingDryRun({
      createdByMemberId: "admin_1",
    });
    expect(dryRunId).toBe("dr_persisted");
    expect(mocks.dryRunCreate).toHaveBeenCalledTimes(1);
    const data = mocks.dryRunCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      mode: "MEMBERSHIP_TYPE_AND_AGE",
      rulesFingerprint: snapshot.rulesFingerprint,
      plannedDigest: snapshot.plannedDigest,
      mismatchCount: snapshot.mismatchCount,
      createdByMemberId: "admin_1",
    });
    expect(new Date(data.cacheCursorAt).toISOString()).toBe(snapshot.lastRefreshedAt);
  });

  it("does not persist (returns dryRunId=null) when the group cache has never refreshed", async () => {
    mocks.cursorFindUnique.mockResolvedValue(null);
    const { dryRunId } = await recordXeroMemberGroupingDryRun({});
    expect(dryRunId).toBeNull();
    expect(mocks.dryRunCreate).not.toHaveBeenCalled();
  });
});
