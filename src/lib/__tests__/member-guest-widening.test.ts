// "+ Add Member Guest" (epic #2305) MG2 (#2307) — THE WIDENING CONTRACT.
//
// THIS FILE IS THE DELIBERATE INVERSE OF MG1'S DARK-GUARANTEE SUITE, and the
// inversion is the point rather than an accident of refactoring. MG1 (#2306)
// proved that no request through any call site, in any module state, with any
// actor, could widen the family boundary or write a non-null `consentStatus`.
// MG2 turns that off. Every assertion MG1 wrote to fail loudly the moment the
// widening moved HAS now failed, on purpose, and this file is what replaced it.
//
// Renamed from `member-guest-dark-guarantee.test.ts` so the filename cannot
// outlive the guarantee it named. Three specific MG1 assertions were rewritten
// rather than deleted, and they are called out where they appear:
//
//   * A.1 — "module ON is byte-for-byte module OFF" is now "module OFF is
//     byte-for-byte the pre-feature behaviour, and module ON widens".
//   * A.2 — "a beyond-family add is refused with the module ON" is now "a
//     beyond-family add SUCCEEDS with the module on, and is refused with the
//     identical pre-existing error with it off".
//   * E.22 — the mutation probe that asserted `MEMBER_GUEST_WIDENING_ENABLED`
//     was `false` is replaced by its inverse: the widening is now an explicit
//     per-call option that FAILS CLOSED, so the probe is that omitting it
//     refuses, and hard-coding it true breaks the module-off case.
//
// What survives unchanged, because MG2 did not change it: an inactive member is
// unresolvable in every module state; `group-booking.ts` stays family-scoped
// (owner decision MG1-D-a); the boundary is computed on every path including
// the admin ones; and neither open-search privacy toggle has a reader that
// decides who is discoverable (that arrives with MG3).
//
// The behavioural matrix is still paired with structural assertions read from
// the real source files, for the same reason as in MG1: some of these
// properties — where the boundary is computed, which files may write a consent
// column — cannot be observed from behaviour at all.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BookingGuestValidationError,
  computeMemberGuestBoundary,
  resolveLinkedBookingMembers,
  resolveLinkedBookingMembersWithBoundary,
} from "@/lib/booking-guests";
import {
  CONSENT_FREE_GUEST_COLUMNS,
  MEMBER_GUEST_MODULE_KEY,
} from "@/lib/member-guest-consent";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
} from "@/config/modules";
import { DEFAULT_MEMBER_GUEST_SETTINGS } from "@/config/club-settings-defaults";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { buildClubModuleSettingsPayload } from "@/lib/module-settings";

// Test helper: reads a fixed repo file under process.cwd(); the path is
// test-controlled, not user input.
function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// Fixture world
// ---------------------------------------------------------------------------
// BOOKER and SIBLING share family group "fg-1". OUTSIDER is an ordinary active
// member in no shared group — the exact person this epic exists to let in, and
// the person MG1 must still refuse. INACTIVE is beyond the boundary AND
// inactive, so it can never resolve for two independent reasons.
const BOOKER = "m-booker";
const SIBLING = "m-sibling";
const OUTSIDER = "m-outsider";
const INACTIVE = "m-inactive";

const FAMILY_LINKS: Record<string, string[]> = {
  [BOOKER]: ["fg-1"],
  [SIBLING]: ["fg-1"],
  [OUTSIDER]: ["fg-2"],
  [INACTIVE]: [],
};

const MEMBERS: Record<string, { ageTier: string; active: boolean; canLogin: boolean }> = {
  [BOOKER]: { ageTier: "ADULT", active: true, canLogin: true },
  [SIBLING]: { ageTier: "ADULT", active: true, canLogin: true },
  [OUTSIDER]: { ageTier: "ADULT", active: true, canLogin: true },
  [INACTIVE]: { ageTier: "ADULT", active: false, canLogin: true },
};

type FindManyArgs = { where?: Record<string, unknown>; select?: Record<string, unknown> };

/**
 * A stand-in for the two Prisma delegates resolveLinkedBookingMembers touches.
 * Deliberately hand-written rather than mocked per call: the family-group
 * queries are the thing under test, so the fake has to answer them the way the
 * database would, not the way a recorded mock happened to be primed.
 */
function makeDb() {
  const familyGroupMemberFindMany = vi.fn(async (args: FindManyArgs) => {
    const where = (args.where ?? {}) as {
      memberId?: string;
      familyGroupId?: { in: string[] };
    };
    if (where.memberId) {
      return (FAMILY_LINKS[where.memberId] ?? []).map((familyGroupId) => ({
        familyGroupId,
      }));
    }
    const groupIds = where.familyGroupId?.in ?? [];
    const rows: Array<{ memberId: string }> = [];
    for (const [memberId, groups] of Object.entries(FAMILY_LINKS)) {
      if (groups.some((g) => groupIds.includes(g))) rows.push({ memberId });
    }
    return rows;
  });

  const memberFindMany = vi.fn(async (args: FindManyArgs) => {
    const where = (args.where ?? {}) as {
      id?: { in: string[] };
      active?: boolean;
    };
    const ids = where.id?.in ?? [];
    return ids
      .filter((id) => MEMBERS[id] && (where.active !== true || MEMBERS[id].active))
      .map((id) => ({
        id,
        ageTier: MEMBERS[id].ageTier,
        active: MEMBERS[id].active,
        canLogin: MEMBERS[id].canLogin,
        firstName: "Test",
        lastName: id,
        accessRoles: [],
      }));
  });

  return {
    familyGroupMember: { findMany: familyGroupMemberFindMany },
    member: { findMany: memberFindMany },
  };
}

type FakeDb = ReturnType<typeof makeDb>;
type LookupDb = Parameters<typeof resolveLinkedBookingMembers>[0];

function asLookupDb(db: FakeDb): LookupDb {
  return db as unknown as LookupDb;
}

/**
 * A ClubModuleSettings client stub for isEffectiveModuleEnabled, so each case
 * can prove the module really IS in the state it claims while the booking
 * outcome stays put.
 */
function moduleClient(memberGuests: boolean) {
  return {
    clubModuleSettings: {
      findUnique: async () => ({
        ...DEFAULT_MODULE_SETTINGS,
        memberGuests,
        updatedAt: new Date(0),
        updatedByMemberId: null,
      }),
    },
  };
}

/**
 * The seven files that call the helper, and the `skipAuthorization` values each
 * one can actually pass.
 *
 * THE CENSUS IS LOAD-BEARING, not bookkeeping: it is what tells MG2 how many
 * paths need a consent decision. The first version of this table hard-coded
 * `false` for the three routes that pass a DYNAMIC flag, which made the count
 * read "four of seven skip" when the true answer is SIX of seven — and, worse,
 * meant the matrix below never ran those three in their skipping mode at all.
 * So a file whose flag is dynamic declares BOTH modes and is run twice, and
 * "declares each call site's real authorization modes" below reads the modes
 * back off the real source.
 */
const CALL_SITES = [
  {
    name: "api/bookings/route.ts",
    file: "src/app/api/bookings/route.ts",
    /** `skipAuthorization: isAuthorizedOnBehalf` — admin/officer on-behalf. */
    skipAuthorizationModes: [false, true],
  },
  {
    name: "api/bookings/quote/route.ts",
    file: "src/app/api/bookings/quote/route.ts",
    /** `skipAuthorization: isAuthorizedOnBehalf`. */
    skipAuthorizationModes: [false, true],
  },
  {
    name: "api/bookings/[id]/guests/route.ts",
    file: "src/app/api/bookings/[id]/guests/route.ts",
    /** `skipAuthorization: isAdmin`. */
    skipAuthorizationModes: [false, true],
  },
  {
    name: "api/bookings/[id]/modify-quote/route.ts",
    file: "src/app/api/bookings/[id]/modify-quote/route.ts",
    /** `skipAuthorization: isAdmin`. */
    skipAuthorizationModes: [false, true],
  },
  {
    name: "booking-modify-plan.ts",
    file: "src/lib/booking-modify-plan.ts",
    /** `skipAuthorization: role === "ADMIN"`. */
    skipAuthorizationModes: [false, true],
  },
  {
    name: "admin-booking-copy.ts",
    file: "src/lib/admin-booking-copy.ts",
    /** Hard-coded `true`: there is no non-admin booking copy. */
    skipAuthorizationModes: [true],
  },
  {
    name: "group-booking.ts (join)",
    file: "src/lib/group-booking.ts",
    /** Passes NO options — owner decision MG1-D-a keeps the join family-scoped. */
    skipAuthorizationModes: [false],
  },
] as const;

/** How many of the seven can reach the `skipAuthorization` branch. */
const CALL_SITES_THAT_CAN_SKIP = 6;

/** The seven files that call the helper. */
const CALL_SITE_FILES = CALL_SITES.map((site) => site.file);

/**
 * One matrix run per (file, authorization mode) pair — twelve in all, so every
 * dynamic site is genuinely exercised in its skipping mode too.
 */
const CALL_SITE_RUNS = CALL_SITES.flatMap((site) =>
  site.skipAuthorizationModes.map((skipAuthorization) => ({
    name: `${site.name} [skipAuthorization=${skipAuthorization}]`,
    skipAuthorization,
  })),
);

// ---------------------------------------------------------------------------
// The consent-column sweep vocabulary
// ---------------------------------------------------------------------------
/** The five consent columns MG1 provisions on `BookingGuest`. */
const CONSENT_COLUMNS = [
  "consentStatus",
  "consentRequestedAt",
  "consentRespondedAt",
  "consentRespondedByMemberId",
  "consentExpiresAt",
] as const;

const CONSENT_COLUMN_ALTERNATION = CONSENT_COLUMNS.join("|");

/** Any mention at all, quoted or not — the blunt "who is even naming this" pass. */
const CONSENT_COLUMN_MENTION = new RegExp(`\\b(?:${CONSENT_COLUMN_ALTERNATION})\\b`);

/**
 * MG1 declared two further sweep patterns here, and MG2 DELETES both rather than
 * leaving them unused, because each rests on a premise this release ends.
 *
 * `CONSENT_COLUMN_WRITE` was a write-shaped regex (`consentStatus: x`,
 * `row.consentStatus = x`, the raw-SQL `SET` form). It is gone because it cannot
 * tell a Prisma `data:` payload from a `select:` or a `where:` — now that MG2
 * reads these columns in a dozen places it flagged every READER as a writer, and
 * a sweep that mislabels readers is worse than one that simply lists everybody.
 *
 * `CONSENT_COLUMN_ALLOWLIST` named the only three files permitted to so much as
 * MENTION a consent column. Its premise — that nothing may name one — is exactly
 * what MG2 is.
 *
 * What replaced both is the declared census in "consent columns have exactly one
 * writer" below: the same closed-world shape, built on `CONSENT_COLUMN_MENTION`,
 * aimed at a claim that is still true.
 */

/**
 * Run a resolve and describe the outcome as plain, comparable data.
 *
 * `memberGuestWideningEnabled` is deliberately OMITTED when false rather than
 * passed as `false`, so every "module off" case below also exercises the
 * fail-closed default — see the E.22-replacement probe.
 */
async function outcomeOf(
  db: FakeDb,
  memberIds: string[],
  skipAuthorization: boolean,
  memberGuestWideningEnabled = false,
): Promise<
  | { kind: "resolved"; ids: string[] }
  | { kind: "refused"; message: string; status: number; className: string }
> {
  try {
    const members = await resolveLinkedBookingMembers(
      asLookupDb(db),
      BOOKER,
      memberIds,
      {
        skipAuthorization,
        ...(memberGuestWideningEnabled ? { memberGuestWideningEnabled: true } : {}),
      },
    );
    return { kind: "resolved", ids: [...members.keys()].sort() };
  } catch (error) {
    if (error instanceof BookingGuestValidationError) {
      return {
        kind: "refused",
        message: error.message,
        status: error.status,
        className: error.constructor.name,
      };
    }
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// A.1 (INVERTED) — module OFF is byte-for-byte the pre-feature behaviour;
//                  module ON widens, at every call site
// ---------------------------------------------------------------------------
describe("the memberGuests module now decides whether the boundary widens", () => {
  it("still ships OFF by default, and the stub really does flip it", async () => {
    // Owner decision D-2 survives MG2 unchanged: an existing club sees zero
    // change until an admin turns the module on. If this fails, every "module
    // off" case below is comparing "on" with "on" and proves nothing.
    expect(DEFAULT_MODULE_SETTINGS.memberGuests).toBe(false);
    await expect(
      isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY, moduleClient(false)),
    ).resolves.toBe(false);
    await expect(
      isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY, moduleClient(true)),
    ).resolves.toBe(true);
  });

  describe.each(CALL_SITE_RUNS)("$name", ({ skipAuthorization }) => {
    it.each([
      { label: "the booker themselves", ids: [BOOKER] },
      { label: "a family-group co-member", ids: [SIBLING] },
      { label: "no member guests at all", ids: [] },
    ])(
      "resolves $label identically whether the module is off or on",
      async ({ ids }) => {
        // A.1's surviving half. Widening changes ONE thing — whether a
        // beyond-family ACTIVE member resolves. Everything else must be
        // untouched, and these four cases are what pins that: a family party's
        // behaviour cannot drift just because the module was switched on.
        const off = await outcomeOf(makeDb(), ids, skipAuthorization, false);
        const on = await outcomeOf(makeDb(), ids, skipAuthorization, true);
        expect(on).toEqual(off);
      },
    );

    it("refuses a beyond-family member with the module off and resolves them with it on", async () => {
      // A.1's inverted half, run at every (call site, authorization mode) pair.
      const off = await outcomeOf(makeDb(), [OUTSIDER], skipAuthorization, false);
      const on = await outcomeOf(makeDb(), [OUTSIDER], skipAuthorization, true);

      if (skipAuthorization) {
        // An admin path never enforced the boundary, so the module does not
        // change its OUTCOME — it changes what consent state the row that
        // follows carries. That is asserted where the writers live; here the
        // point is that the admin path was already open and MG2 did not narrow
        // it.
        expect(off).toEqual({ kind: "resolved", ids: [OUTSIDER] });
        expect(on).toEqual({ kind: "resolved", ids: [OUTSIDER] });
        return;
      }

      expect(off).toMatchObject({ kind: "refused", status: 403 });
      expect(on).toEqual({ kind: "resolved", ids: [OUTSIDER] });
    });
  });

  it("refuses a beyond-family add with the exact pre-existing error, module OFF", async () => {
    // A.2, INVERTED. The message and the status code are still the load-bearing
    // part, but the claim has moved: a club that has NOT opted in must see the
    // byte-for-byte pre-feature refusal, with no hint that a member-guest
    // feature exists at all.
    await expect(
      isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY, moduleClient(false)),
    ).resolves.toBe(false);

    const outcome = await outcomeOf(makeDb(), [OUTSIDER], false, false);
    expect(outcome).toEqual({
      kind: "refused",
      message: "Invalid guest member reference",
      status: 403,
      className: "BookingGuestValidationError",
    });
  });

  it("keeps the refusal neutral even with the module ON", async () => {
    // Owner decision D-8: the reasons a particular cross-family member cannot be
    // added are collapsed to one neutral response, so no refusal here may name
    // the member, their household, or their financial state. With the module on
    // a resolvable member resolves, so the only refusal left on this path is the
    // inactive one — and it must stay as anonymous as it is today.
    const outcome = await outcomeOf(makeDb(), [INACTIVE], false, true);
    expect(outcome).toMatchObject({ kind: "refused" });
    if (outcome.kind === "refused") {
      expect(outcome.message).not.toContain(INACTIVE);
      expect(outcome.message.toLowerCase()).not.toMatch(/subscription|unpaid|family/);
    }
  });

  it("refuses the whole party when one member is beyond the boundary, module OFF", async () => {
    // No partial success: a mixed party is all-or-nothing, as today.
    const outcome = await outcomeOf(makeDb(), [SIBLING, OUTSIDER], false, false);
    expect(outcome).toMatchObject({ kind: "refused", status: 403 });
  });

  it("resolves a mixed family + beyond-family party with the module ON", async () => {
    const outcome = await outcomeOf(makeDb(), [SIBLING, OUTSIDER], false, true);
    expect(outcome).toEqual({ kind: "resolved", ids: [OUTSIDER, SIBLING].sort() });
  });

  it("never resolves an inactive member, in either module state or either authorization mode", async () => {
    // A.5. Inactive-ness is enforced after the boundary, so an admin path that
    // skips authorization must still be refused here.
    for (const skipAuthorization of [false, true]) {
      for (const widening of [false, true]) {
        const outcome = await outcomeOf(
          makeDb(),
          [INACTIVE],
          skipAuthorization,
          widening,
        );
        expect(outcome).toMatchObject({ kind: "refused" });
      }
    }
  });

  it("keeps the group-booking join family-scoped (MG1-D-a)", async () => {
    // group-booking.ts passes NO options at all, so authorization is enforced
    // AND the widening option is absent — which, because the option fails
    // closed, is exactly what keeps the join family-scoped now that the feature
    // is live. Owner decision MG1-D-a. Both halves are asserted: the source
    // passes neither option, and the behaviour still refuses.
    const source = readRepoFile("src/lib/group-booking.ts");
    const call = source.slice(source.indexOf("resolveLinkedBookingMembers("));
    const args = call.slice(0, call.indexOf(");"));
    expect(args).not.toContain("skipAuthorization");
    expect(args).not.toContain("memberGuestWideningEnabled");

    const outcome = await outcomeOf(makeDb(), [OUTSIDER], false, false);
    expect(outcome).toMatchObject({ kind: "refused", status: 403 });
  });
});

// ---------------------------------------------------------------------------
// A.4 — the boundary is computed on the skipAuthorization path
// ---------------------------------------------------------------------------
describe("the family boundary is computed on every path, including the admin ones", () => {
  it("classifies a beyond-family member correctly with skipAuthorization set", async () => {
    // THE assertion of this PR. It cannot be inferred from behaviour: in this
    // release the outcome is identical whether or not the boundary was ever
    // computed. So the computed value is read directly. If the computation is
    // moved inside the `if (!options?.skipAuthorization)` branch, this fails.
    const { members, boundary } = await resolveLinkedBookingMembersWithBoundary(
      asLookupDb(makeDb()),
      BOOKER,
      [SIBLING, OUTSIDER],
      { skipAuthorization: true },
    );

    expect([...members.keys()].sort()).toEqual([OUTSIDER, SIBLING].sort());
    expect(boundary.scopeByMemberId.get(SIBLING)).toBe("FAMILY");
    expect(boundary.scopeByMemberId.get(OUTSIDER)).toBe("BEYOND_FAMILY");
    expect(boundary.beyondFamilyMemberIds).toEqual([OUTSIDER]);
  });

  it("actually queries the family groups on the skipAuthorization path", async () => {
    // Belt and braces for the same rule, from the other side: the family-group
    // reads must happen even where nothing is enforced.
    const db = makeDb();
    await resolveLinkedBookingMembersWithBoundary(asLookupDb(db), BOOKER, [OUTSIDER], {
      skipAuthorization: true,
    });
    expect(db.familyGroupMember.findMany).toHaveBeenCalled();
  });

  it("classifies the booker themselves as inside the boundary", async () => {
    const boundary = await computeMemberGuestBoundary(asLookupDb(makeDb()), BOOKER, [BOOKER]);
    expect(boundary.scopeByMemberId.get(BOOKER)).toBe("FAMILY");
    expect(boundary.beyondFamilyMemberIds).toEqual([]);
  });

  it("treats a booker with no family group as a boundary of one", async () => {
    const boundary = await computeMemberGuestBoundary(asLookupDb(makeDb()), INACTIVE, [
      INACTIVE,
      SIBLING,
    ]);
    expect(boundary.scopeByMemberId.get(INACTIVE)).toBe("FAMILY");
    expect(boundary.scopeByMemberId.get(SIBLING)).toBe("BEYOND_FAMILY");
  });

  it("adds no query to the authorized path (the boundary IS the allow-set)", async () => {
    // The boundary reuses getAllowedGuestMemberIds rather than introducing a
    // second definition of "family", so the ordinary member path costs exactly
    // what it did before: two FamilyGroupMember reads, not four.
    const db = makeDb();
    await resolveLinkedBookingMembers(asLookupDb(db), BOOKER, [SIBLING], {
      skipAuthorization: false,
    });
    expect(db.familyGroupMember.findMany).toHaveBeenCalledTimes(2);
  });

  it("does no work at all for a party with no member guests", async () => {
    const db = makeDb();
    const members = await resolveLinkedBookingMembers(asLookupDb(db), BOOKER, [null, "", undefined]);
    expect(members.size).toBe(0);
    expect(db.familyGroupMember.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Structural pins — read from the real source, not from behaviour
// ---------------------------------------------------------------------------
describe("call-site survey", () => {
  /** Every production file under src/ that names either helper as a call. */
  function callersOf(helper: string): string[] {
    return productionFilesUnder("src")
      // booking-guests.ts is where both helpers are DEFINED.
      .filter((file) => file !== "src/lib/booking-guests.ts")
      // A plain substring is enough and cannot misfire: the boundary variant's
      // name does not CONTAIN `resolveLinkedBookingMembers(`, because the `(`
      // only follows the longer name.
      .filter((file) => readRepoFile(file).includes(`${helper}(`))
      .sort();
  }

  /** Either helper: MG2 moves the persisting sites onto the boundary variant. */
  function allCallers(): string[] {
    return [
      ...new Set([
        ...callersOf("resolveLinkedBookingMembers"),
        ...callersOf("resolveLinkedBookingMembersWithBoundary"),
      ]),
    ].sort();
  }

  it("still has exactly seven call-site files, six of which can skip authorization", () => {
    // SET EQUALITY, not "each declared file still contains the call". The weaker
    // form only proves the seven known files have not stopped calling it: a
    // planted EIGHTH caller passes it untouched, and an eighth caller is a
    // consent decision nobody made. The count was re-measured against `main` at
    // ae0e6f64 with #2335 / #2332 / #2316 still open, and is unchanged at seven.
    expect(allCallers()).toEqual([...CALL_SITE_FILES].sort());
    expect(new Set(CALL_SITE_FILES).size).toBe(CALL_SITE_FILES.length);
    expect(
      CALL_SITES.filter((site) =>
        site.skipAuthorizationModes.some((mode) => mode === true),
      ),
    ).toHaveLength(CALL_SITES_THAT_CAN_SKIP);
  });

  it("declares each call site's real authorization modes", () => {
    // Read the modes back off the source, so the table cannot claim a route is
    // member-only when it passes a runtime admin flag — the exact error the
    // original "four of seven" count came from.
    for (const site of CALL_SITES) {
      const source = readRepoFile(site.file);
      const at = Math.max(
        source.indexOf("await resolveLinkedBookingMembers("),
        source.indexOf("await resolveLinkedBookingMembersWithBoundary("),
      );
      expect(at, `${site.file}: no awaited resolve call`).toBeGreaterThan(-1);
      const call = source.slice(at, source.indexOf(");", at));

      if (/skipAuthorization:\s*true\b/.test(call)) {
        // A literal true: the site can ONLY skip.
        expect([...site.skipAuthorizationModes], site.name).toEqual([true]);
      } else if (/skipAuthorization/.test(call)) {
        // A runtime flag: BOTH modes are reachable, so both must be exercised.
        expect([...site.skipAuthorizationModes].sort(), site.name).toEqual([false, true]);
      } else {
        // No option at all: authorization is always enforced.
        expect([...site.skipAuthorizationModes], site.name).toEqual([false]);
      }
    }
  });

  it("gives every widening-capable call site the option, and group-booking none", () => {
    // MG1's version of this case asserted the exact opposite — that NO file had
    // adopted the boundary-returning variant yet, because adopting it was MG2's
    // job. This is that assertion inverted, and it is the one that would catch
    // the worst possible half-finished state: a call site that resolves a
    // cross-family member WITHOUT a consent decision attached to the row it
    // writes. Six sites must pass the widening option; `group-booking.ts` must
    // pass neither it nor `skipAuthorization`, which is owner decision MG1-D-a
    // and the reason the join stays family-scoped now that everything else is
    // open.
    for (const site of CALL_SITES) {
      const source = readRepoFile(site.file);
      if (site.file === "src/lib/group-booking.ts") {
        expect(source, site.name).not.toContain("memberGuestWideningEnabled");
        continue;
      }
      expect(source, site.name).toContain("memberGuestWideningEnabled");
    }
  });
});

describe("the boundary computation sits outside the authorization branch", () => {
  it("computes the boundary before the skipAuthorization check", () => {
    // The mutation this guards (E.23): move the computeMemberGuestBoundary call
    // inside `if (!options?.skipAuthorization)`. The behavioural test above
    // catches it too; this one says WHY in the failure message.
    const source = readRepoFile("src/lib/booking-guests.ts");
    const body = source.slice(
      source.indexOf("export async function resolveLinkedBookingMembersWithBoundary"),
    );
    const boundaryAt = body.indexOf("await computeMemberGuestBoundary(");
    const branchAt = body.indexOf("if (!options?.skipAuthorization)");
    expect(boundaryAt).toBeGreaterThan(-1);
    expect(branchAt).toBeGreaterThan(-1);
    expect(boundaryAt).toBeLessThan(branchAt);
  });
});

describe("E.22 replaced: the widening option fails closed", () => {
  // MG1's E.22 asserted `MEMBER_GUEST_WIDENING_ENABLED === false` and existed to
  // make the flip impossible to land quietly. It has done its job and is gone.
  // Its replacement asserts the property that now carries the same weight: the
  // widening is a per-call option with NO safe default other than "refuse", so a
  // call site that forgets it, or a future call site nobody remembers to update,
  // keeps the pre-feature behaviour instead of silently minting consent-free
  // cross-family guest rows.
  it("refuses a beyond-family member when the option is omitted entirely", async () => {
    const outcome = await resolveLinkedBookingMembers(
      asLookupDb(makeDb()),
      BOOKER,
      [OUTSIDER],
      // Deliberately only skipAuthorization: false — no widening key at all.
      { skipAuthorization: false },
    ).then(
      (members) => ({ kind: "resolved" as const, ids: [...members.keys()] }),
      (error: unknown) => ({
        kind: "refused" as const,
        status: error instanceof BookingGuestValidationError ? error.status : 0,
      }),
    );

    expect(outcome).toEqual({ kind: "refused", status: 403 });
  });

  it("refuses on any falsy or non-true value, not just on absence", async () => {
    // The guard is written as `!== true` rather than `=== false` on purpose: a
    // caller that threads an `undefined` or a `null` through from a settings read
    // that failed must land on refuse, not on widen.
    for (const value of [undefined, null, false, 0, ""]) {
      const outcome = await resolveLinkedBookingMembers(
        asLookupDb(makeDb()),
        BOOKER,
        [OUTSIDER],
        {
          skipAuthorization: false,
          memberGuestWideningEnabled: value as unknown as boolean | undefined,
        },
      ).then(
        () => "resolved",
        () => "refused",
      );
      expect(outcome, `value ${String(value)} must not widen`).toBe("refused");
    }
  });

  it("names the module key once, in the file that explains what it gates", () => {
    // MUTATION PROBE (the inverse of MG1's): hard-code the guard in
    // booking-guests.ts to `true` and the "module OFF" cases above fail. Delete
    // the guard entirely and they fail too. This assertion pins the structural
    // half — that the option is read from the options object and not from a
    // module lookup smuggled into the resolver, which would put a settings read
    // inside a booking transaction.
    expect(MEMBER_GUEST_MODULE_KEY).toBe("memberGuests");
    const source = readRepoFile("src/lib/booking-guests.ts");
    expect(source).toContain("options?.memberGuestWideningEnabled !== true");
    expect(source).not.toContain("isEffectiveModuleEnabled");
  });
});

describe("consent columns have exactly one writer", () => {
  it("declares the consent-free shape unchanged", () => {
    // MG1's A.3 survives verbatim: a family-scope add is consent-FREE, not
    // consent-GIVEN. NULL must never be written as CONFIRMED, or the model loses
    // the ability to tell "nobody had to be asked" from "somebody said yes".
    expect(CONSENT_FREE_GUEST_COLUMNS).toEqual({
      consentStatus: null,
      consentRequestedAt: null,
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
      consentExpiresAt: null,
    });
  });

  it("keeps every production file that touches a consent column on a declared census", () => {
    // MG1's blunt "no production file may even NAME a consent column" sweep
    // cannot survive MG2 — MG2 is the release that reads and writes them. What
    // replaces it is the same closed-world shape aimed at the property that still
    // matters: the set of files that touch consent AT ALL is short, declared, and
    // reviewed. A new file cannot start reading or writing a consent column
    // without somebody adding it here and saying, in one line, why.
    //
    // Deliberately the MENTION regex, not a write-shaped one. A write-shaped
    // regex cannot tell a Prisma `data:` payload from a `select:` or a `where:` —
    // it flagged every reader too — and a census that silently mislabels readers
    // as writers is worse than one that just lists everybody.
    const census: Record<string, string> = {
      // The model: the eight-shape table, the classifier, the presence predicate,
      // and the single `buildMemberGuestConsentWrite` every add path goes through.
      "src/lib/member-guest-consent.ts": "the model",
      // The state machine: the status-guarded claim and nothing else.
      "src/lib/member-guest-consent-service.ts": "the state machine",
      // The sweep's candidate query.
      "src/lib/cron-member-guest-consent-expiry.ts": "the expiry sweep's candidate scan",
      // Reads the target id before a decline deletes the row.
      "src/app/api/bookings/[id]/guests/[guestId]/consent/route.ts":
        "the consent response endpoint",
      // The structural-rule comment on the boundary computation.
      "src/lib/booking-guests.ts": "a comment about where the boundary is computed",
      // The FK-less-member-id-scalar audit list.
      "src/lib/member-merge.ts": "the merge classification of consentRespondedByMemberId",
      // D-12 exclusion sites and the one deliberate non-exclusion.
      "src/lib/double-bed-sharing.ts": "D-12: pending guests do not anchor an offer",
      "src/app/api/member/data-export/route.ts":
        "deliberately NOT excluded — a data-subject export includes their own pending rows",
      "src/lib/email-templates.ts": "the consent email renderers",
      "src/lib/email/member-guest.ts": "the consent email senders",
      // The per-request policy read and the pure write plan every add path uses.
      "src/lib/member-guest-add-policy.ts": "the add paths' shared consent-write plan",
      // The one post-commit notifier the four persisting paths share.
      "src/lib/member-guest-consent-notifications.ts":
        "the post-commit add notifier",
      "src/lib/email-message-audit-defaults.ts": "the consent templates' default bodies",
      "src/lib/email-message-registry.ts": "the consent templates' registry entries",
      // The narrow consent authority that lets a delegate decline and the sweep
      // expire — see its own doc comment for why it exists and what it refuses.
      "src/lib/booking-guest-removal-service.ts": "the consent removal authority",
    };

    const mentions = productionFilesUnder("src")
      .map((file) => file.split("\\").join("/"))
      .filter((file) => CONSENT_COLUMN_MENTION.test(readRepoFile(file)))
      .filter((file) => !(file in census));

    expect(mentions).toEqual([]);
  });
});

describe("the two open-search privacy toggles are inert and off", () => {
  it("ships both off", () => {
    // E.25's target, twice over: the shared defaults constant AND the schema
    // column default, because config transfer reads one and a fresh install
    // gets the other.
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.openMemberSearchEnabled).toBe(false);
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.openMemberSearchIncludesMinors).toBe(false);

    const schema = readRepoFile("prisma/schema.prisma");
    expect(schema).toMatch(/openMemberSearchEnabled\s+Boolean\s+@default\(false\)/);
    expect(schema).toMatch(/openMemberSearchIncludesMinors\s+Boolean\s+@default\(false\)/);
  });

  it("is named only by the files that store or administer them, never by a reader", () => {
    // D.20. Until MG3 ships the type-ahead, the ONLY files allowed to name these
    // columns are the schema, the shared defaults, the loader that fills them in,
    // the config-transfer spec that refuses to export them — and, from MG2
    // (#2307, owner decision D-17), the admin route that lets a club's own admin
    // set them. That route is a WRITER, not a reader: it validates, persists and
    // audits the two values, and still nothing anywhere consumes either of them
    // to decide who is discoverable — that arrives with MG3's type-ahead.
    const allowed = new Set([
      "src/config/club-settings-defaults.ts",
      "src/lib/member-guest-settings.ts",
      "src/lib/config-transfer/categories/club-settings.ts",
      "src/app/api/admin/member-guest-settings/route.ts",
    ]);
    const readers = sourceFilesUnder("src")
      .filter((file) => !file.includes("__tests__"))
      .filter((file) => !allowed.has(file.replace(/\\/g, "/")))
      .filter((file) => /openMemberSearch/.test(readRepoFile(file)));
    expect(readers).toEqual([]);
  });
});

describe("the module flag now gates the widening, and says so", () => {
  it("is read by the booking path, which is the whole change", () => {
    // THE INVERSE of MG1's assertion. MG1 required that NO production file check
    // `isEffectiveModuleEnabled("memberGuests")`, because module-on had to be
    // unobservable. MG2 requires the opposite: the persisting call sites read it
    // and pass the answer down. An empty reader list here would mean the module
    // switch is decorative again.
    expect(MODULE_KEYS).toContain("memberGuests");
    const readers = sourceFilesUnder("src")
      .filter((file) => !file.includes("__tests__"))
      .filter((file) =>
        /isEffectiveModuleEnabled\(\s*(?:["']memberGuests["']|MEMBER_GUEST_MODULE_KEY)/.test(
          readRepoFile(file),
        ),
      );
    expect(readers.length).toBeGreaterThan(0);
  });

  it("no longer tells an admin the switch does nothing (D-17)", () => {
    // MG1 shipped the switch with a "Not available yet" prefix on its
    // description and a dependency note saying the same, precisely so nobody
    // would turn it on over an inert feature. MG2 is the release that makes it
    // real, so that copy MUST be gone — leaving it would be a worse lie than
    // shipping it was.
    const definition = MODULE_DEFINITIONS.memberGuests;
    expect(definition.key).toBe("memberGuests");
    expect(definition.label.length).toBeGreaterThan(0);
    expect(definition.description).not.toMatch(/not available yet/i);
    expect(definition.dependencies.join(" ")).not.toMatch(/not available yet/i);
    // And it must still explain what it does, in plain English, to an admin who
    // is deciding whether to turn it on.
    expect(definition.description).toMatch(/family group/i);
  });

  it("reports itself ready when switched on, and disabled when not", () => {
    // MG1's `not_available_yet` readiness branch existed for one release and is
    // deleted here, in the same change that flips the widening — its own comment
    // said to. A module whose behaviour has shipped must read as ready.
    const statusFor = (memberGuests: boolean) => {
      const found = buildClubModuleSettingsPayload({ memberGuests }).modules.find(
        (entry) => entry.key === "memberGuests",
      );
      expect(found, "memberGuests missing from the module payload").toBeDefined();
      return found!;
    };

    expect(statusFor(false).readiness.status).toBe("admin_disabled");

    const on = statusFor(true);
    expect(on.adminEnabled).toBe(true);
    expect(on.readiness.status).toBe("ready");
    expect(on.readiness.status).not.toBe("not_available_yet");
  });

  it("has no producer of the retired `not_available_yet` readiness state", () => {
    // Structural, because a leftover branch for a DIFFERENT module key would be
    // invisible to the behavioural case above. The check is for a producer — a
    // `status:` assignment — not for the string, so the comment recording why the
    // state was retired is allowed to name it.
    for (const file of [
      "src/lib/module-settings.ts",
      "src/app/(admin)/admin/modules/page.tsx",
    ]) {
      expect(readRepoFile(file), file).not.toMatch(
        /status:\s*["']not_available_yet["']/,
      );
    }
  });
});


// ---------------------------------------------------------------------------
// The admin-facing half of D-17 — INVERTED, and the reason matters
// ---------------------------------------------------------------------------
describe("the admin Modules card renders memberGuests as an ordinary module (D-17)", () => {
  // MG1's verify pass added a block here pinning the CLIENT half of the
  // "Not available yet" badge: readinessVariant must map it amber, readinessLabel
  // must say "Not available yet", and getReadiness must return early for it so an
  // optimistic re-render could not flash it green. Every one of those assertions
  // was RIGHT for MG1 and is WRONG for MG2, so this block is their inverse rather
  // than a deletion — and it keeps the insight that made MG1 write them, which is
  // the part worth carrying forward.
  //
  // THAT INSIGHT: the three helpers are module-private to a `"use client"` page
  // whose only export is the default component, so no behavioural test can reach
  // them. MG1 found that a refactor dropping the `not_available_yet` case from any
  // of the three would leave the server payload correct, every test green, and the
  // badge green over a feature that could not run. The mirror-image hazard now
  // applies: a `not_available_yet` case LEFT BEHIND in any of the three would
  // badge a working feature amber and label it unavailable, and no behavioural
  // test would notice that either. So the same three helpers are pinned
  // structurally, in the opposite direction.
  const PAGE = "src/app/(admin)/admin/modules/page.tsx";

  /** The text of a top-level `function name(...) {...}` declaration. */
  function functionBody(name: string): string {
    const source = readRepoFile(PAGE);
    const at = source.indexOf(`function ${name}(`);
    expect(at, `${name} is not declared in the Modules page`).toBeGreaterThan(-1);
    // Top-level declarations close on a brace in column one.
    const end = source.indexOf("\n}", at);
    expect(end, `${name} has no closing brace`).toBeGreaterThan(at);
    return source.slice(at, end);
  }

  it.each(["readinessVariant", "readinessLabel", "getReadiness"])(
    "%s no longer special-cases the retired not_available_yet state",
    (name) => {
      expect(functionBody(name)).not.toContain("not_available_yet");
    },
  );

  it("still special-cases credentials_missing, so the branch was not blanket-deleted", () => {
    // The point of removing one state is not to flatten the readiness logic. A
    // module that genuinely needs setup must still badge amber and must still
    // survive the optimistic re-render, and that is the assertion which would
    // fail if somebody "simplified" all three helpers at once.
    expect(functionBody("readinessVariant")).toContain("credentials_missing");
    expect(functionBody("readinessLabel")).toContain("credentials_missing");
    const getReadiness = functionBody("getReadiness");
    const earlyReturnAt = getReadiness.indexOf("credentials_missing");
    const readyAt = getReadiness.indexOf('status: "ready"');
    expect(earlyReturnAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(earlyReturnAt).toBeLessThan(readyAt);
  });

  it("badges memberGuests exactly like any other credential-free module", () => {
    // The behavioural half, so the structural pins above cannot pass while the
    // payload says something different.
    const memberGuests = buildClubModuleSettingsPayload({ memberGuests: true }).modules.find(
      (entry) => entry.key === "memberGuests",
    );
    const notices = buildClubModuleSettingsPayload({ memberNotices: true }).modules.find(
      (entry) => entry.key === "memberNotices",
    );
    expect(memberGuests!.readiness.status).toBe(notices!.readiness.status);
    expect(memberGuests!.readiness.status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Local file walker (kept at the bottom; it is plumbing, not the point)
// ---------------------------------------------------------------------------
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(path.resolve(process.cwd(), current), {
      withFileTypes: true,
    })) {
      const next = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.tsx?$/.test(entry.name)) out.push(next);
    }
  };
  walk(dir);
  return out;
}

/** The same walk, without the test files — what "production code" means here. */
function productionFilesUnder(dir: string): string[] {
  return sourceFilesUnder(dir).filter((file) => !file.includes("__tests__"));
}
