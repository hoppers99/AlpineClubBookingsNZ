import { describe, expect, it, vi } from "vitest";
import { evaluateMemberMergeGuards } from "@/lib/member-merge";

const MASTER_ID = "master-1";
const LOSER_ID = "loser-1";
const ACTOR_ID = "admin-1";

function guardMember(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    active: true,
    archivedAt: null,
    firstName: id === LOSER_ID ? "Dup" : "Real",
    lastName: "Person",
    email: `${id}@example.com`,
    accessRoles: [] as { role: string | null }[],
    ...overrides,
  };
}

function defaultDelegate() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  };
}

function contactCreateFailure(providerContactCreated = true) {
  return {
    id: "xero-op-1",
    responsePayload: {
      phase: "local_link_after_xero_resolution",
      providerContactCreated,
    },
  };
}

function staleResetContactCreatePendingProof() {
  return {
    id: "xero-op-stale-reset",
    status: "FAILED",
    responsePayload: {
      phase: "provider_contact_created_local_link_pending",
      providerContactCreated: true,
    },
  };
}

describe("unresolved Xero contact-create recovery blockers", () => {
  it.each([
    ["master", MASTER_ID, "master_xero_contact_create_recovery_pending"],
    ["duplicate", LOSER_ID, "loser_xero_contact_create_recovery_pending"],
  ])("blocks when the %s has provider-created local-link recovery", async (_side, id, code) => {
    const xeroSyncOperation = {
      ...defaultDelegate(),
      findFirst: vi.fn(({ where }: { where: { localId: string } }) =>
        Promise.resolve(where.localId === id ? contactCreateFailure() : null),
      ),
    };

    const blockers = await runGuards({ xeroSyncOperation });

    expect(blockers.map((blocker) => blocker.code)).toContain(code);
    expect(blockers.find((blocker) => blocker.code === code)?.label).toMatch(
      /Wait for it to finish, or resolve the failed Xero operation/,
    );
  });

  it("blocks an exact active contact-create reservation", async () => {
    const xeroSyncOperation = {
      ...defaultDelegate(),
      findFirst: vi.fn(({ where }: { where: { localId: string } }) =>
        Promise.resolve(
          where.localId === LOSER_ID
            ? { id: "xero-running", status: "RUNNING", responsePayload: null }
            : null,
        ),
      ),
    };

    const blockers = await runGuards({ xeroSyncOperation });
    expect(blockers.map((blocker) => blocker.code)).toContain(
      "loser_xero_contact_create_recovery_pending",
    );
  });

  it("blocks merge after a provider-created pending-link row is reset to FAILED", async () => {
    const xeroSyncOperation = {
      ...defaultDelegate(),
      findFirst: vi.fn(({ where }: { where: { localId: string } }) =>
        Promise.resolve(
          where.localId === LOSER_ID
            ? staleResetContactCreatePendingProof()
            : null,
        ),
      ),
    };

    const blockers = await runGuards({ xeroSyncOperation });
    expect(blockers.map((blocker) => blocker.code)).toContain(
      "loser_xero_contact_create_recovery_pending",
    );
  });

  it("blocks merge on an unmarked contact-create reservation reset as stale", async () => {
    const xeroSyncOperation = {
      ...defaultDelegate(),
      findFirst: vi.fn(
        ({ where }: { where: { localId: string; OR: unknown[] } }) => {
          if (where.localId !== LOSER_ID) return Promise.resolve(null);
          expect(where.OR).toEqual(
            expect.arrayContaining([
              {
                status: "FAILED",
                lastErrorCode: "ORPHANED_STALE_RUNNING",
              },
            ]),
          );
          return Promise.resolve({
            id: "xero-stale-reset",
            status: "FAILED",
            lastErrorCode: "ORPHANED_STALE_RUNNING",
            responsePayload: null,
          });
        },
      ),
    };

    const blockers = await runGuards({ xeroSyncOperation });
    expect(blockers.map((blocker) => blocker.code)).toContain(
      "loser_xero_contact_create_recovery_pending",
    );
  });

  it("does not block matched-existing, manually resolved, or non-failed operations", async () => {
    const excludedOperations = [
      {
        status: "FAILED",
        manuallyResolvedAt: null,
        responsePayload: contactCreateFailure(false).responsePayload,
      },
      {
        status: "FAILED",
        manuallyResolvedAt: new Date("2026-07-01T00:00:00Z"),
        responsePayload: contactCreateFailure().responsePayload,
      },
      {
        status: "SUCCEEDED",
        manuallyResolvedAt: null,
        responsePayload: contactCreateFailure().responsePayload,
      },
    ];
    const xeroSyncOperation = {
      ...defaultDelegate(),
      // Prisma applies the exact where-clause before returning a candidate.
      // These deliberately non-matching rows therefore produce no result.
      findFirst: vi.fn(({ where }: { where: { OR: unknown[]; manuallyResolvedAt: null } }) => {
        expect(where.OR).toEqual(expect.arrayContaining([expect.objectContaining({ status: "RUNNING" })]));
        expect(where.manuallyResolvedAt).toBeNull();
        expect(excludedOperations).toHaveLength(3);
        return Promise.resolve(null);
      }),
    };

    await expect(runGuards({ xeroSyncOperation })).resolves.toEqual([]);
  });
});

/**
 * Proxy mock db: member.count answers the actorIsFullAdmin /
 * wouldRemoveLastFullAdmin queries; other delegates default to zero counts and
 * empty findMany unless overridden.
 */
function makeDb(overrides: Record<string, unknown> = {}) {
  const memberDelegate = {
    ...defaultDelegate(),
    count: vi.fn(({ where }: { where: { id?: string } }) =>
      Promise.resolve(where?.id === ACTOR_ID ? 1 : 0),
    ),
  };
  const cache = new Map<string, unknown>();
  cache.set("member", overrides.member ?? memberDelegate);
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in overrides) return overrides[prop as keyof typeof overrides];
        if (!cache.has(prop)) cache.set(prop, defaultDelegate());
        return cache.get(prop);
      },
    },
  );
}

async function runGuards(dbOverrides: Record<string, unknown> = {}) {
  return evaluateMemberMergeGuards({
    db: makeDb(dbOverrides) as never,
    actorMemberId: ACTOR_ID,
    master: guardMember(MASTER_ID) as never,
    loser: guardMember(LOSER_ID) as never,
    masterId: MASTER_ID,
    loserId: LOSER_ID,
  });
}

/**
 * A memberSubscription.findMany mock: the guard queries the MASTER for ALL
 * rows (no OR filter) and the LOSER for MEANINGFUL rows only (OR filter
 * present), so the mock keys off `where.OR` to emulate meaningfulness.
 */
function subscriptionFindMany(config: {
  masterSeasons: number[];
  loserMeaningfulSeasons: number[];
}) {
  return vi.fn(({ where }: { where: { memberId: string; OR?: unknown } }) => {
    if (where.memberId === MASTER_ID && !where.OR) {
      return Promise.resolve(config.masterSeasons.map((seasonYear) => ({ seasonYear })));
    }
    if (where.memberId === LOSER_ID && where.OR) {
      return Promise.resolve(
        config.loserMeaningfulSeasons.map((seasonYear) => ({ seasonYear })),
      );
    }
    return Promise.resolve([]);
  });
}

describe("subscription-collision blocker (B1 matrix)", () => {
  it("BLOCKS master-meaningless + loser-meaningful for the same season (paid history must never be dropped)", async () => {
    // Master holds a meaningless NOT_INVOICED 2026 row (still a row for the
    // season); loser holds a PAID 2026 row with an invoice link (meaningful).
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2026],
          loserMeaningfulSeasons: [2026],
        }),
      },
    });
    expect(blockers.map((b) => b.code)).toContain("subscription_collision");
  });

  it("BLOCKS a colliding loser row backed by charge coverage (never a late P2003)", async () => {
    // A coverage-backed loser row is meaningful via chargeCoverage even when
    // NOT_INVOICED with no Xero fields; dropping it would P2003 on the
    // onDelete:Restrict MembershipSubscriptionChargeCoverage FK.
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2025],
          loserMeaningfulSeasons: [2025],
        }),
      },
    });
    expect(blockers.map((b) => b.code)).toContain("subscription_collision");
  });

  it("does NOT block both-meaningless for the same season (loser row is droppable)", async () => {
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2026],
          loserMeaningfulSeasons: [], // loser's colliding row is meaningless
        }),
      },
    });
    expect(blockers).toEqual([]);
  });

  it("does NOT block a loser-only meaningful subscription (no master row for the season -> moved)", async () => {
    const blockers = await runGuards({
      memberSubscription: {
        ...defaultDelegate(),
        findMany: subscriptionFindMany({
          masterSeasons: [2024],
          loserMeaningfulSeasons: [2026],
        }),
      },
    });
    expect(blockers).toEqual([]);
  });
});

describe("pending DeletionRequest blocker (M2)", () => {
  it("blocks when the LOSER has a PENDING account-deletion request", async () => {
    const deletionRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: { memberId: string; status: string } }) =>
        Promise.resolve(where.memberId === LOSER_ID && where.status === "PENDING" ? 1 : 0),
      ),
    };
    const blockers = await runGuards({ deletionRequest });
    expect(blockers.map((b) => b.code)).toContain("loser_pending_requests");
    expect(blockers.map((b) => b.code)).not.toContain("master_pending_requests");
  });

  it("blocks when the MASTER has a PENDING account-deletion request", async () => {
    const deletionRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: { memberId: string; status: string } }) =>
        Promise.resolve(where.memberId === MASTER_ID && where.status === "PENDING" ? 1 : 0),
      ),
    };
    const blockers = await runGuards({ deletionRequest });
    expect(blockers.map((b) => b.code)).toContain("master_pending_requests");
    expect(blockers.map((b) => b.code)).not.toContain("loser_pending_requests");
  });

  it("only PENDING deletion requests block (queries filter on status)", async () => {
    const deletionRequest = {
      ...defaultDelegate(),
      count: vi.fn(({ where }: { where: { status?: string } }) => {
        expect(where.status).toBe("PENDING");
        return Promise.resolve(0);
      }),
    };
    const blockers = await runGuards({ deletionRequest });
    expect(blockers).toEqual([]);
    expect(deletionRequest.count).toHaveBeenCalledTimes(2); // master AND loser
  });
});
