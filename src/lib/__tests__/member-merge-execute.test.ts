import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  buildMemberMergePreviewToken,
  executeMemberMerge,
  MEMBER_MERGE_RELATION_SPECS,
  MemberMergeError,
  mergeMemberFields,
  type MemberMergePreviewCore,
} from "@/lib/member-merge";
import { classifyMemberGuestConsent } from "@/lib/member-guest-consent";

const MASTER_ID = "master-1";
const LOSER_ID = "loser-1";
const ACTOR_ID = "admin-1";

function makeMember(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    firstName: id === LOSER_ID ? "Dup" : "Real",
    lastName: "Person",
    active: true,
    archivedAt: null,
    canLogin: true,
    xeroContactId: null,
    joinedDate: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2021-01-01T00:00:00Z"),
    requiresInduction: false,
    hutLeaderEligible: false,
    hutLeaderEligibleAt: null,
    ...overrides,
  };
}

const master = makeMember(MASTER_ID, { occupation: null });
const loser = makeMember(LOSER_ID, { occupation: "Engineer" });

function validToken() {
  const core: MemberMergePreviewCore = {
    fieldMerge: mergeMemberFields(
      master as unknown as Record<string, unknown>,
      loser as unknown as Record<string, unknown>,
    ).diff,
    relationMoves: [],
    collisions: [],
    blockers: [],
    warnings: [],
  };
  return buildMemberMergePreviewToken(
    MASTER_ID,
    LOSER_ID,
    master.updatedAt,
    loser.updatedAt,
    core,
  );
}

function defaultDelegate() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
  };
}

/**
 * Build a mock transaction client. `overrides` supplies specific delegates;
 * everything else falls back to a benign default delegate (0 counts, empty
 * findMany, etc.). Returns { tx, spies } where spies are the shared delegates
 * used for assertions.
 */
function makeClient(overrides: Record<string, unknown> = {}) {
  const memberDelegate = {
    ...defaultDelegate(),
    findUnique: vi.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null),
    ),
    // actorIsFullAdmin -> 1 for the actor; wouldRemoveLastFullAdmin(loser) -> 0.
    count: vi.fn(({ where }: { where: { id?: string } }) =>
      Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
    ),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };

  const cache = new Map<string, unknown>();
  cache.set("member", overrides.member ?? memberDelegate);
  cache.set("auditLog", overrides.auditLog ?? { create: vi.fn().mockResolvedValue({}) });

  const tx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$executeRaw") return vi.fn().mockResolvedValue(0);
        if (prop in overrides) return overrides[prop as keyof typeof overrides];
        if (!cache.has(prop)) cache.set(prop, defaultDelegate());
        return cache.get(prop);
      },
    },
  );

  const client = {
    $transaction: (cb: (tx: unknown) => unknown) => cb(tx),
  };

  return { client, tx, member: cache.get("member"), auditLog: cache.get("auditLog") };
}

describe("executeMemberMerge", () => {
  it("rejects a self-merge before opening a transaction", async () => {
    const { client } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: MASTER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: "x",
        confirmationText: "x",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "same_member" });
  });

  it("merges: verifies token, moves history, writes MEMBER_MERGED audit, deletes the loser", async () => {
    const { client, member, auditLog } = makeClient();

    const result = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "  MERGE   Dup Person ",
      db: client as never,
    });

    expect(result.masterId).toBe(MASTER_ID);
    // Field merge patch (occupation filled from loser) applied to master.
    const memberSpy = member as { update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.update).toHaveBeenCalled();
    // One critical audit.
    const auditSpy = auditLog as { create: ReturnType<typeof vi.fn> };
    expect(auditSpy.create).toHaveBeenCalledTimes(1);
    // Loser hard-deleted.
    expect(memberSpy.delete).toHaveBeenCalledWith({ where: { id: LOSER_ID } });
  });

  it("nulls the loser's googleSub before delete and never transfers it to the master (#2035)", async () => {
    // Loser carries a linked Google account; master has none. googleSub is a
    // scalar @unique excluded from the field-fill lists, so the master must NOT
    // inherit it (no login-identity takeover), and the loser's is nulled before
    // the hard-delete. Recomputed preview token is unaffected (googleSub is not
    // a merged field), so validToken() still verifies.
    const loserWithGoogle = { ...loser, googleSub: "sub-loser" };
    const memberDelegate = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === MASTER_ID
            ? master
            : where.id === LOSER_ID
              ? loserWithGoogle
              : null,
        ),
      ),
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    const { client } = makeClient({ member: memberDelegate });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    const updateCalls = memberDelegate.update.mock.calls.map(([arg]) => arg) as {
      where: { id: string };
      data: Record<string, unknown>;
    }[];
    // Loser's googleSub explicitly nulled.
    expect(updateCalls).toContainEqual({
      where: { id: LOSER_ID },
      data: { googleSub: null },
    });
    // Master is never written a googleSub value.
    for (const call of updateCalls) {
      if (call.where.id === MASTER_ID) {
        expect(call.data).not.toHaveProperty("googleSub");
      }
    }
    expect(memberDelegate.delete).toHaveBeenCalledWith({ where: { id: LOSER_ID } });
  });

  it("returns 409 preview_drift when the token does not match current state", async () => {
    const { client, member } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: "stale-token",
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "preview_drift" });
    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).not.toHaveBeenCalled();
  });

  it("returns 422 when the confirmation phrase is wrong (loser not deleted)", async () => {
    const { client, member } = makeClient();
    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Wrong Name",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "confirmation_mismatch" });
    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).not.toHaveBeenCalled();
  });

  it("blocks (409) when the actor is not a Full Admin; loser untouched", async () => {
    const nonAdminMember = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null),
      ),
      count: vi.fn().mockResolvedValue(0), // actor not a full admin
      delete: vi.fn().mockResolvedValue({}),
    };
    const { client } = makeClient({ member: nonAdminMember });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "merge_blocked" });
    expect(nonAdminMember.delete).not.toHaveBeenCalled();
  });

  it("blocks when the loser holds an admin access role", async () => {
    const memberDelegate = {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === MASTER_ID ? master : where.id === LOSER_ID ? loser : null),
      ),
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      delete: vi.fn().mockResolvedValue({}),
    };
    const memberAccessRole = {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId: string } }) =>
        Promise.resolve(where.memberId === LOSER_ID ? [{ role: "ADMIN" }] : []),
      ),
    };
    const { client } = makeClient({ member: memberDelegate, memberAccessRole });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "merge_blocked" });
    expect(memberDelegate.delete).not.toHaveBeenCalled();
  });

  it("rolls back (no delete, no audit) when a move fails mid-transaction", async () => {
    const booking = {
      ...defaultDelegate(),
      updateMany: vi.fn().mockRejectedValue(new Error("db exploded during move")),
    };
    const { client, member, auditLog } = makeClient({ booking });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toThrow("db exploded during move");

    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    const auditSpy = auditLog as { create: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).not.toHaveBeenCalled();
    expect(auditSpy.create).not.toHaveBeenCalled();
  });

  it("re-points the loser's ENTRANCE_FEE_INVOICE link to the master", async () => {
    const xeroObjectLink = {
      ...defaultDelegate(),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "x1",
          role: "ENTRANCE_FEE_INVOICE",
          xeroObjectType: "Invoice",
          xeroObjectId: "inv-1",
          active: true,
        },
      ]),
      count: vi.fn().mockResolvedValue(0), // master has no entrance-fee link
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const { client } = makeClient({ xeroObjectLink });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(xeroObjectLink.update).toHaveBeenCalledWith({
      where: { id: "x1" },
      data: { localId: MASTER_ID },
    });
  });

  it("deactivates the loser's ENTRANCE_FEE_INVOICE link when the master already has one", async () => {
    const xeroObjectLink = {
      ...defaultDelegate(),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "x1",
          role: "ENTRANCE_FEE_INVOICE",
          xeroObjectType: "Invoice",
          xeroObjectId: "inv-1",
          active: true,
        },
      ]),
      count: vi.fn().mockResolvedValue(1), // master already has an entrance-fee link
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const { client } = makeClient({ xeroObjectLink });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(xeroObjectLink.update).toHaveBeenCalledWith({
      where: { id: "x1" },
      data: { active: false },
    });
  });
});

describe("subscription collision handling at execute time (B1)", () => {
  /**
   * memberSubscription delegate: `count` (used for the token collision
   * summary) stays 0 so validToken() matches; `findMany` distinguishes the
   * guard's meaningful-loser query (has `OR`) from the resolver's plain
   * member queries (no `OR`).
   */
  function subscriptionDelegate(config: {
    masterRows: { id: string; seasonYear: number }[];
    loserRows: { id: string; seasonYear: number }[];
    loserMeaningfulSeasons: number[];
  }) {
    return {
      ...defaultDelegate(),
      findMany: vi.fn(({ where }: { where: { memberId?: string; OR?: unknown } }) => {
        if (where.OR) {
          return Promise.resolve(
            where.memberId === LOSER_ID
              ? config.loserMeaningfulSeasons.map((seasonYear) => ({ seasonYear }))
              : [],
          );
        }
        if (where.memberId === LOSER_ID) return Promise.resolve(config.loserRows);
        if (where.memberId === MASTER_ID) return Promise.resolve(config.masterRows);
        return Promise.resolve([]);
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
  }

  it("blocks in-tx when a meaningful loser subscription collides with ANY master row (no delete, no drop)", async () => {
    const memberSubscription = subscriptionDelegate({
      masterRows: [{ id: "MS1", seasonYear: 2026 }], // master's row may be meaningless
      loserRows: [{ id: "LS1", seasonYear: 2026 }],
      loserMeaningfulSeasons: [2026], // loser's is PAID/invoiced/covered
    });
    const { client, member } = makeClient({ memberSubscription });

    await expect(
      executeMemberMerge({
        masterId: MASTER_ID,
        loserId: LOSER_ID,
        actorMemberId: ACTOR_ID,
        previewToken: validToken(),
        confirmationText: "MERGE Dup Person",
        db: client as never,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "merge_blocked" });

    expect(memberSubscription.deleteMany).not.toHaveBeenCalled();
    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).not.toHaveBeenCalled();
  });

  it("drops a MEANINGLESS colliding loser subscription row (both-meaningless case)", async () => {
    const memberSubscription = subscriptionDelegate({
      masterRows: [{ id: "MS1", seasonYear: 2026 }],
      loserRows: [{ id: "LS1", seasonYear: 2026 }],
      loserMeaningfulSeasons: [], // loser row is NOT_INVOICED with no history
    });
    const { client } = makeClient({ memberSubscription });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(memberSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["LS1"] } },
    });
    expect(memberSubscription.updateMany).toHaveBeenCalledWith({
      where: { memberId: LOSER_ID },
      data: { memberId: MASTER_ID },
    });
  });

  it("moves a loser-only subscription (even a meaningful one) without dropping anything", async () => {
    const memberSubscription = subscriptionDelegate({
      masterRows: [], // master has no row for the season
      loserRows: [{ id: "LS1", seasonYear: 2026 }],
      loserMeaningfulSeasons: [2026],
    });
    const { client } = makeClient({ memberSubscription });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: validToken(),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(memberSubscription.deleteMany).not.toHaveBeenCalled();
    expect(memberSubscription.updateMany).toHaveBeenCalledWith({
      where: { memberId: LOSER_ID },
      data: { memberId: MASTER_ID },
    });
  });
});

describe("partner-link warnings reach the audit metadata (M3)", () => {
  it("records the CONFIRMED-drop warning in the MEMBER_MERGED audit", async () => {
    const loserLinks = [
      { id: "L1", memberAId: LOSER_ID, memberBId: "zzz-third", status: "CONFIRMED" },
    ];
    const masterLinks = [
      { id: "M1", memberAId: MASTER_ID, memberBId: "yyy-partner", status: "CONFIRMED" },
    ];
    const memberPartnerLink = {
      ...defaultDelegate(),
      findMany: vi.fn(
        ({ where }: { where: { OR?: { memberAId?: string }[] } }) =>
          Promise.resolve(
            where.OR?.[0]?.memberAId === LOSER_ID ? loserLinks : masterLinks,
          ),
      ),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    };
    const { client, auditLog } = makeClient({ memberPartnerLink });

    // The token digest includes the partner collision summary, so build it
    // exactly as the execute path will compute it pre-mutation.
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(
        master as unknown as Record<string, unknown>,
        loser as unknown as Record<string, unknown>,
      ).diff,
      relationMoves: [],
      collisions: [
        {
          model: "MemberPartnerLink.memberA/memberB",
          resolution: "re-point 0, drop 1 (self-pair/duplicate/confirmed)",
          count: 1,
        },
      ],
      blockers: [],
      warnings: [],
    };
    const token = buildMemberMergePreviewToken(
      MASTER_ID,
      LOSER_ID,
      master.updatedAt,
      loser.updatedAt,
      core,
    );

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: token,
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    expect(memberPartnerLink.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["L1"] } },
    });
    const auditSpy = auditLog as { create: ReturnType<typeof vi.fn> };
    expect(auditSpy.create).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(auditSpy.create.mock.calls[0][0]);
    expect(serialized).toContain("resolutionWarnings");
    expect(serialized).toContain("confirmed partner link dropped");
  });
});

describe("member-photo reconciliation at execute time (MP1, #189)", () => {
  /** A member delegate whose findUnique returns the supplied photo-bearing pair. */
  function photoMemberDelegate(masterRow: unknown, loserRow: unknown) {
    return {
      ...defaultDelegate(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === MASTER_ID ? masterRow : where.id === LOSER_ID ? loserRow : null,
        ),
      ),
      // actorIsFullAdmin -> 1 for the actor; every other count (e.g.
      // wouldRemoveLastFullAdmin) -> 0.
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
  }

  function photoToken(masterRow: Record<string, unknown>, loserRow: Record<string, unknown>) {
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(masterRow, loserRow).diff,
      relationMoves: [],
      collisions: [],
      blockers: [],
      warnings: [],
    };
    return buildMemberMergePreviewToken(
      MASTER_ID,
      LOSER_ID,
      masterRow.updatedAt as Date,
      loserRow.updatedAt as Date,
      core,
    );
  }

  it("keeps the master's photo and deletes the loser's orphaned MEMBER_PHOTO blob", async () => {
    const masterRow = makeMember(MASTER_ID, { occupation: null, photoImageId: "master-img" });
    const loserRow = makeMember(LOSER_ID, { occupation: "Engineer", photoImageId: "loser-img" });
    const mediaImage = { ...defaultDelegate(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const { client, member } = makeClient({
      member: photoMemberDelegate(masterRow, loserRow),
      mediaImage,
    });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: photoToken(
        masterRow as unknown as Record<string, unknown>,
        loserRow as unknown as Record<string, unknown>,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    // Master keeps master-img; the loser's own MEMBER_PHOTO plus any blob it
    // uploaded that no OTHER surviving member references is swept, excluding the
    // master's kept photo. The `photoOfMembers` carve-out spares photos the
    // loser uploaded on behalf of members who still reference them.
    expect(mediaImage.deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [{ uploadedByMemberId: LOSER_ID }, { id: "loser-img" }],
        photoOfMembers: { none: { id: { not: LOSER_ID } } },
        NOT: { id: "master-img" },
      },
    });
    // The loser is still hard-deleted.
    const memberSpy = member as { delete: ReturnType<typeof vi.fn> };
    expect(memberSpy.delete).toHaveBeenCalledWith({ where: { id: LOSER_ID } });
  });

  it("absorbs the loser's photo when the master has none and never deletes the absorbed blob", async () => {
    const masterRow = makeMember(MASTER_ID, { occupation: null, photoImageId: null });
    const loserRow = makeMember(LOSER_ID, { occupation: "Engineer", photoImageId: "loser-img" });
    const mediaImage = { ...defaultDelegate(), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
    const { client, member } = makeClient({
      member: photoMemberDelegate(masterRow, loserRow),
      mediaImage,
    });

    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: photoToken(
        masterRow as unknown as Record<string, unknown>,
        loserRow as unknown as Record<string, unknown>,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    // Master absorbs loser-img via the field merge...
    const memberSpy = member as { update: ReturnType<typeof vi.fn> };
    expect(memberSpy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MASTER_ID },
        data: expect.objectContaining({ photoImageId: "loser-img" }),
      }),
    );
    // ...and the sweep excludes loser-img (now the master's photo) from deletion.
    expect(mediaImage.deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [{ uploadedByMemberId: LOSER_ID }, { id: "loser-img" }],
        photoOfMembers: { none: { id: { not: LOSER_ID } } },
        NOT: { id: "loser-img" },
      },
    });
  });

  it("sweeps the loser's CURRENT photo (read fresh under lock), not the stale snapshot", async () => {
    // Race: an admin POSTs a photo ON BEHALF OF the loser AFTER the merge's
    // top-of-transaction `loserFull` snapshot (photoImageId "L1") but BEFORE the
    // reconcile. The upload creates blob "L2" (uploadedByMemberId = the ADMIN,
    // NOT the loser), repoints the loser to L2 and deletes L1. By reconcile time
    // the loser row is row-locked (teardownLoserXero's member.update), so a fresh
    // locked read returns L2 — the value the sweep must key on so L2 is not
    // orphaned once the loser is hard-deleted. We model this by making the
    // loser's `findUnique` return the stale L1 for the plain snapshot read and
    // the fresh L2 for the `select: { photoImageId }` locked read at reconcile.
    const masterRow = makeMember(MASTER_ID, { occupation: null, photoImageId: "master-img" });
    const staleLoser = makeMember(LOSER_ID, { occupation: "Engineer", photoImageId: "L1" });
    const memberDelegate = {
      ...defaultDelegate(),
      findUnique: vi.fn(
        ({ where, select }: { where: { id: string }; select?: { photoImageId?: boolean } }) => {
          if (where.id === MASTER_ID) return Promise.resolve(masterRow);
          if (where.id !== LOSER_ID) return Promise.resolve(null);
          // The fresh locked read at reconcile time carries select.photoImageId;
          // it must observe the CURRENT pointer (L2) set by the racing upload.
          if (select?.photoImageId) return Promise.resolve({ photoImageId: "L2" });
          // Every other loser read (the top-of-tx snapshot, guards, token) sees
          // the stale pre-upload snapshot (L1).
          return Promise.resolve(staleLoser);
        },
      ),
      count: vi.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
      ),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    const mediaImage = { ...defaultDelegate(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const { client, member } = makeClient({ member: memberDelegate, mediaImage });

    // The preview token is built from the stale snapshot (what the admin saw when
    // opening the merge). Master keeps its own photo, so photoImageId is not in
    // the field-merge patch and the token is unaffected by the loser's pointer.
    await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: photoToken(
        masterRow as unknown as Record<string, unknown>,
        staleLoser as unknown as Record<string, unknown>,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });

    // The sweep predicate keys on the FRESH pointer L2 (not the stale L1), so the
    // just-created L2 blob — still referenced only by the loser at reconcile time
    // — is swept and cannot orphan once the loser is deleted.
    expect(mediaImage.deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [{ uploadedByMemberId: LOSER_ID }, { id: "L2" }],
        photoOfMembers: { none: { id: { not: LOSER_ID } } },
        NOT: { id: "master-img" },
      },
    });
    // Guard against regression: the stale L1 must NOT be the swept id.
    const sweep = mediaImage.deleteMany.mock.calls[0][0] as {
      where: { OR: { id?: string }[] };
    };
    expect(sweep.where.OR).not.toContainEqual({ id: "L1" });
    // The fresh locked read of the loser's photoImageId happened.
    const memberFindUnique = (member as { findUnique: ReturnType<typeof vi.fn> }).findUnique;
    expect(memberFindUnique).toHaveBeenCalledWith({
      where: { id: LOSER_ID },
      select: { photoImageId: true },
    });
    // The loser is still hard-deleted.
    expect((member as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith({
      where: { id: LOSER_ID },
    });
  });
});

// ---------------------------------------------------------------------------
// "+ Add Member Guest" (epic #2305) MG2 (#2307) — what a merge does to consent
// ---------------------------------------------------------------------------
//
// `BookingGuest.member` is classified `move`, so merging A into B re-points A's
// guest rows onto B — INCLUDING their consent columns. MG1 (#2306) recorded that
// as an accepted consequence and noted it was unreachable in that release, because
// every `consentStatus` was NULL and there was nothing to inherit. MG2 makes rows
// carry a status, so the consequence is now real and these are its tests.
//
// Two of them describe behaviour that is arguably wrong and is asserted anyway,
// because an unasserted hazard is one nobody can find later: the merge silently
// changes what an approval MEANS, and it can leave two guest rows for the same
// person on one booking. Both are called out where they appear.
describe("a merge and the consent columns it carries with it (#2307)", () => {
  const BOOKING = "bk-merge";

  type GuestRow = {
    id: string;
    bookingId: string;
    memberId: string | null;
    consentStatus: string | null;
    consentRequestedAt: Date | null;
    consentRespondedAt: Date | null;
    consentRespondedByMemberId: string | null;
    consentExpiresAt: Date | null;
  };

  /**
   * A stateful `bookingGuest` delegate: `updateMany` really re-points rows, so the
   * end state can be inspected instead of only the call arguments.
   */
  function bookingGuestDelegate(rows: GuestRow[]) {
    const store = rows.map((row) => ({ ...row }));
    return {
      ...defaultDelegate(),
      count: vi.fn(async ({ where }: { where: { memberId?: string } }) =>
        store.filter((row) => row.memberId === where.memberId).length,
      ),
      findMany: vi.fn(async ({ where }: { where: { memberId?: string } }) =>
        store.filter((row) => row.memberId === where.memberId).map((row) => ({ id: row.id })),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { memberId?: string };
          data: { memberId?: string };
        }) => {
          const hits = store.filter((row) => row.memberId === where.memberId);
          for (const row of hits) Object.assign(row, data);
          return { count: hits.length };
        },
      ),
      store,
    };
  }

  /** The preview token the execute path will recompute, given the guest-row count. */
  function tokenWithGuestRows(count: number) {
    const core: MemberMergePreviewCore = {
      fieldMerge: mergeMemberFields(
        master as unknown as Record<string, unknown>,
        loser as unknown as Record<string, unknown>,
      ).diff,
      relationMoves: count > 0 ? [{ model: "BookingGuest.member", count }] : [],
      collisions: [],
      blockers: [],
      warnings: [],
    };
    return buildMemberMergePreviewToken(
      MASTER_ID,
      LOSER_ID,
      master.updatedAt,
      loser.updatedAt,
      core,
    );
  }

  async function mergeWithGuests(rows: GuestRow[]) {
    const bookingGuest = bookingGuestDelegate(rows);
    const { client, auditLog } = makeClient({ bookingGuest });
    const result = await executeMemberMerge({
      masterId: MASTER_ID,
      loserId: LOSER_ID,
      actorMemberId: ACTOR_ID,
      previewToken: tokenWithGuestRows(
        rows.filter((row) => row.memberId === LOSER_ID).length,
      ),
      confirmationText: "MERGE Dup Person",
      db: client as never,
    });
    return { result, store: bookingGuest.store, bookingGuest, auditLog };
  }

  it("re-points the loser's guest rows, so the survivor inherits the consent", async () => {
    // The plain case. The loser said yes to being on somebody's booking; after the
    // merge that same place belongs to the survivor, consent and all. Nothing is
    // re-asked and nothing is cleared — which is the right outcome for the booking
    // (the bed is still legitimately held) even though it means the survivor is
    // now standing behind a decision the loser made.
    const { result, store } = await mergeWithGuests([
      {
        id: "g-1",
        bookingId: BOOKING,
        memberId: LOSER_ID,
        consentStatus: "CONFIRMED",
        consentRequestedAt: new Date("2026-07-01T00:00:00.000Z"),
        consentRespondedAt: new Date("2026-07-02T00:00:00.000Z"),
        consentRespondedByMemberId: LOSER_ID,
        consentExpiresAt: null,
      },
    ]);

    expect(store[0].memberId).toBe(MASTER_ID);
    expect(store[0].consentStatus).toBe("CONFIRMED");
    expect(result.relationMoves).toContainEqual({ model: "BookingGuest.member", count: 1 });
  });

  it("QUIETLY CHANGES WHAT THE APPROVAL MEANS: a target approval becomes a delegate approval", async () => {
    // ASSERTED BECAUSE IT IS SURPRISING, not because it is desirable.
    //
    // `consentRespondedByMemberId` is a deliberate FK-less SNAPSHOT column: if the
    // person who approved is later merged away, the id stays as it was, because the
    // audit answer to "who stood behind this add" is the person who did it at the
    // time. But `memberId` is `move`, so it becomes the survivor's — and the
    // classifier tells TARGET_APPROVED from DELEGATE_APPROVED by comparing the two.
    //
    // The row therefore reads, after the merge, as though somebody ELSE approved on
    // the survivor's behalf. Both column classifications are individually correct
    // and documented; the interaction between them is not written down anywhere,
    // and it changes an audit answer without any writer having touched the row.
    const requestedAt = new Date("2026-07-01T00:00:00.000Z");
    const respondedAt = new Date("2026-07-02T00:00:00.000Z");
    const before = {
      consentStatus: "CONFIRMED" as const,
      consentRequestedAt: requestedAt,
      consentRespondedAt: respondedAt,
      consentRespondedByMemberId: LOSER_ID,
      consentExpiresAt: null,
    };

    // Before: the member who was asked answered for themselves.
    expect(classifyMemberGuestConsent(before, LOSER_ID)).toBe("TARGET_APPROVED");

    const { store } = await mergeWithGuests([
      { id: "g-1", bookingId: BOOKING, memberId: LOSER_ID, ...before },
    ]);

    // After: the responder is unchanged (it is a snapshot) but the target moved.
    expect(store[0].consentRespondedByMemberId).toBe(LOSER_ID);
    expect(classifyMemberGuestConsent(store[0], store[0].memberId)).toBe("DELEGATE_APPROVED");
  });

  it("carries a PENDING hold and its deadline across, so the sweep inherits it too", async () => {
    // A `PENDING` row holds a bed (D-4) and the sweep finds it through the partial
    // index. Re-pointing it does not touch `consentExpiresAt`, so the survivor
    // inherits both the bed hold and the deadline — and if nobody answers, the
    // lapse is processed against the survivor.
    const expiresAt = new Date("2026-08-01T11:00:00.000Z");
    const { store } = await mergeWithGuests([
      {
        id: "g-1",
        bookingId: BOOKING,
        memberId: LOSER_ID,
        consentStatus: "PENDING",
        consentRequestedAt: new Date("2026-07-25T00:00:00.000Z"),
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: expiresAt,
      },
    ]);

    expect(store[0]).toMatchObject({
      memberId: MASTER_ID,
      consentStatus: "PENDING",
      consentExpiresAt: expiresAt,
    });
    expect(classifyMemberGuestConsent(store[0], store[0].memberId)).toBe("AWAITING_TARGET");
  });

  it("PRODUCES TWO GUEST ROWS FOR ONE PERSON ON ONE BOOKING, and says nothing about it", async () => {
    // ASSERTED BECAUSE IT IS UNSAFE, and papering over it would hide it.
    //
    // If both members were already guests on the same booking — which is exactly
    // what a duplicate-member record makes likely, since the duplicate is how the
    // same human ended up entered twice — the merge re-points one row onto the
    // other's member and the booking is left holding TWO places for ONE person.
    // That is a person-night conflict of the kind the booking write paths refuse
    // outright, arrived at through the back door: two beds, two charges, two
    // arrival rows, two chore slots.
    //
    // The merge does not detect it. `BookingGuest.member` is a `move`, not a
    // `resolve`, so there is no collision resolver; the database cannot stop it
    // either, because `BookingGuest` carries no unique on (bookingId, memberId);
    // and the merge reports it as an ordinary relation move with no warning and no
    // blocker. Every part of that is asserted below so the shape of the hazard is
    // on record.
    const { result, store, bookingGuest, auditLog } = await mergeWithGuests([
      {
        id: "g-loser",
        bookingId: BOOKING,
        memberId: LOSER_ID,
        consentStatus: "CONFIRMED",
        consentRequestedAt: new Date("2026-07-01T00:00:00.000Z"),
        consentRespondedAt: new Date("2026-07-02T00:00:00.000Z"),
        consentRespondedByMemberId: LOSER_ID,
        consentExpiresAt: null,
      },
      {
        id: "g-master",
        bookingId: BOOKING,
        memberId: MASTER_ID,
        consentStatus: null,
        consentRequestedAt: null,
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: null,
      },
    ]);

    // Two rows, one booking, one member.
    const onBooking = store.filter((row) => row.bookingId === BOOKING);
    expect(onBooking).toHaveLength(2);
    expect(onBooking.map((row) => row.memberId)).toEqual([MASTER_ID, MASTER_ID]);

    // A single unconditional updateMany, and no collision handling of any kind.
    expect(bookingGuest.updateMany).toHaveBeenCalledTimes(1);
    expect(bookingGuest.updateMany).toHaveBeenCalledWith({
      where: { memberId: LOSER_ID },
      data: { memberId: MASTER_ID },
    });
    expect(result.relationMoves).toContainEqual({ model: "BookingGuest.member", count: 1 });
    expect(result.collisions.map((collision) => collision.model)).not.toContain(
      "BookingGuest.member",
    );
    // Nor does the one critical MEMBER_MERGED audit entry say anything about a
    // duplicated place — so there is no record an operator could act on later.
    const auditSpy = (auditLog as { create: ReturnType<typeof vi.fn> }).create;
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(auditSpy.mock.calls[0][0])).not.toMatch(/duplicat|conflict/i);
  });

  it("has no resolver and no database constraint standing behind that", () => {
    // The structural half of the case above, so the hazard is pinned to its two
    // causes rather than to one test's fixture. If somebody later adds a
    // (bookingId, memberId) unique or reclassifies the relation as `resolve`, this
    // fails and the test above should be rewritten to describe the new behaviour.
    const spec = MEMBER_MERGE_RELATION_SPECS.find(
      (candidate) => candidate.key === "BookingGuest.member",
    );
    expect(spec?.bucket).toBe("move");

    const schema = readFileSync(
      path.resolve(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );
    const model = schema.slice(
      schema.indexOf("model BookingGuest {"),
      schema.indexOf("enum MemberGuestConsentStatus"),
    );
    expect(model).not.toMatch(/@@unique\(\[bookingId,\s*memberId\]\)/);
  });
});

describe("MemberMergeError", () => {
  it("carries a status code and code", () => {
    const err = new MemberMergeError("nope", 409, "preview_drift", { a: 1 });
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("preview_drift");
    expect(err.details).toEqual({ a: 1 });
  });
});
