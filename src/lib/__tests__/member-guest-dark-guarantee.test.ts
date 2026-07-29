// "+ Add Member Guest" (epic #2305) MG1 (#2306) — THE DARK GUARANTEE.
//
// MG1 lands the data model, the module switch, the policy singleton, and the
// consent-boundary plumbing, and changes NOTHING an actor can observe. This
// file is the proof of that, and it is the file to break first when MG2 (#2307)
// deliberately turns the feature on — every assertion here is written so that
// flipping MEMBER_GUEST_WIDENING_ENABLED fails it loudly rather than silently.
//
// The guarantee, stated exactly:
//
//   With MG1 merged, no request through any of the seven
//   resolveLinkedBookingMembers call sites, in any module state, with any actor
//   (member or admin), can create, read, update, or observe a BookingGuest row
//   whose consentStatus is non-null.
//
// Note what is NOT enough on its own: "the tests pass". In this release the
// module flag is not read by the booking path at all, so a behavioural
// ON-vs-OFF comparison would pass even if the plumbing were missing entirely.
// So the behavioural matrix below is paired with structural assertions read
// from the real source files — the call-site survey, the position of the
// boundary computation, and the fact that nothing reads the two privacy
// toggles.
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
  MEMBER_GUEST_WIDENING_ENABLED,
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
 * A VALUE being given to a consent column, in any of the forms a writer could
 * use: `consentStatus: x`, `row.consentStatus = x`, `row["consentStatus"] = x`,
 * and the raw-SQL `SET "consentStatus" = x`. The `=(?!=)` tail means `=== null`
 * and `!== null` comparisons — and bare destructuring — are not matches.
 */
const CONSENT_COLUMN_WRITE = new RegExp(
  `\\b(?:${CONSENT_COLUMN_ALTERNATION})\\b["']?\\s*\\]?\\s*(?::|=(?!=))`,
);

/**
 * The only production files allowed to NAME a consent column in this release.
 * Each is a declaration or a comment, never a writer:
 *   * member-guest-consent.ts — the model (its type and its all-null constant);
 *   * booking-guests.ts       — the structural-rule comment on the boundary;
 *   * member-merge.ts         — the FK-less-member-id-scalar audit list.
 */
const CONSENT_COLUMN_ALLOWLIST = new Set([
  "src/lib/member-guest-consent.ts",
  "src/lib/booking-guests.ts",
  "src/lib/member-merge.ts",
]);

/** Run a resolve and describe the outcome as plain, comparable data. */
async function outcomeOf(
  db: FakeDb,
  memberIds: string[],
  skipAuthorization: boolean,
): Promise<
  | { kind: "resolved"; ids: string[] }
  | { kind: "refused"; message: string; status: number; className: string }
> {
  try {
    const members = await resolveLinkedBookingMembers(
      asLookupDb(db),
      BOOKER,
      memberIds,
      { skipAuthorization },
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
// A.1 / A.2 — module ON is byte-for-byte module OFF, at every call site
// ---------------------------------------------------------------------------
describe("dark guarantee: turning the memberGuests module on changes nothing", () => {
  it("ships OFF by default, and the stub really does flip it", async () => {
    // The premise of every case below. If this fails, the matrix is comparing
    // "off" with "off" and proves nothing.
    expect(DEFAULT_MODULE_SETTINGS.memberGuests).toBe(false);
    await expect(isEffectiveModuleEnabled("memberGuests", moduleClient(false))).resolves.toBe(false);
    await expect(isEffectiveModuleEnabled("memberGuests", moduleClient(true))).resolves.toBe(true);
  });

  describe.each(CALL_SITE_RUNS)("$name", ({ skipAuthorization }) => {
    it.each([
      { label: "the booker themselves", ids: [BOOKER] },
      { label: "a family-group co-member", ids: [SIBLING] },
      { label: "a member beyond the family boundary", ids: [OUTSIDER] },
      { label: "a mixed family + beyond-family party", ids: [SIBLING, OUTSIDER] },
      { label: "an inactive member beyond the boundary", ids: [INACTIVE] },
      { label: "no member guests at all", ids: [] },
    ])("resolves $label identically with the module off and on", async ({ ids }) => {
      // The module state is genuinely different across the two runs...
      await expect(isEffectiveModuleEnabled("memberGuests", moduleClient(false))).resolves.toBe(false);
      const off = await outcomeOf(makeDb(), ids, skipAuthorization);

      await expect(isEffectiveModuleEnabled("memberGuests", moduleClient(true))).resolves.toBe(true);
      const on = await outcomeOf(makeDb(), ids, skipAuthorization);

      // ...and the booking outcome is not.
      expect(on).toEqual(off);
    });
  });

  it("still refuses a beyond-family add with the exact pre-existing error, module ON", async () => {
    // A.2. The message and the status code are the load-bearing part: a new
    // message or a new status would make module-on observable and would
    // pre-empt D-8, which reserves the design of the neutral cross-family
    // refusal surface for MG2.
    await expect(isEffectiveModuleEnabled("memberGuests", moduleClient(true))).resolves.toBe(true);

    const outcome = await outcomeOf(makeDb(), [OUTSIDER], false);
    expect(outcome).toEqual({
      kind: "refused",
      message: "Invalid guest member reference",
      status: 403,
      className: "BookingGuestValidationError",
    });
  });

  it("refuses the whole party when one member is beyond the boundary", async () => {
    // No partial success: a mixed party is all-or-nothing, as today.
    const outcome = await outcomeOf(makeDb(), [SIBLING, OUTSIDER], false);
    expect(outcome).toMatchObject({ kind: "refused", status: 403 });
  });

  it("never resolves an inactive member, in either module state or either authorization mode", async () => {
    // A.5. Inactive-ness is enforced after the boundary, so an admin path that
    // skips authorization must still be refused here.
    for (const skipAuthorization of [false, true]) {
      const outcome = await outcomeOf(makeDb(), [INACTIVE], skipAuthorization);
      expect(outcome).toMatchObject({ kind: "refused" });
    }
  });

  it("keeps the group-booking join family-scoped (MG1-D-a)", async () => {
    // group-booking.ts passes NO options, so authorization is enforced: a
    // joiner can still only bring their own family. Owner decision MG1-D-a
    // keeps it that way in v1 even once the rest of the feature is live.
    const source = readRepoFile("src/lib/group-booking.ts");
    const call = source.slice(source.indexOf("resolveLinkedBookingMembers("));
    expect(call.slice(0, call.indexOf(");"))).not.toContain("skipAuthorization");

    const outcome = await outcomeOf(makeDb(), [OUTSIDER], false);
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
  /** Every production file under src/ that names the given helper as a call. */
  function callersOf(helper: string): string[] {
    return productionFilesUnder("src")
      // booking-guests.ts is where both helpers are DEFINED.
      .filter((file) => file !== "src/lib/booking-guests.ts")
      .filter((file) => readRepoFile(file).includes(`${helper}(`))
      .sort();
  }

  it("still has exactly seven files calling resolveLinkedBookingMembers, six of which can skip authorization", () => {
    // SET EQUALITY, not "each declared file still contains the call". The old
    // form only proved the seven known files had not stopped calling it: a
    // planted EIGHTH caller passed it untouched, which is exactly the case MG2
    // needs to hear about. (The original #2245 survey said six; it was seven.)
    expect(callersOf("resolveLinkedBookingMembers")).toEqual([...CALL_SITE_FILES].sort());
    expect(new Set(CALL_SITE_FILES).size).toBe(CALL_SITE_FILES.length);
    expect(
      CALL_SITES.filter((site) => site.skipAuthorizationModes.includes(true)),
    ).toHaveLength(CALL_SITES_THAT_CAN_SKIP);
  });

  it("declares each call site's real authorization modes", () => {
    // Read the modes back off the source, so the table cannot claim a route is
    // member-only when it passes a runtime admin flag — the exact error the
    // "four of seven" count came from.
    for (const site of CALL_SITES) {
      const source = readRepoFile(site.file);
      const at = source.indexOf("await resolveLinkedBookingMembers(");
      expect(at, `${site.file}: no awaited resolveLinkedBookingMembers call`).toBeGreaterThan(-1);
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

  it("changes no call site in this release", () => {
    // MG1 deliberately leaves every caller on the map-only wrapper: the
    // boundary-returning variant is MG2's to adopt. Also a set-equality sweep,
    // so a NEW file adopting it early is caught, not just one of the seven.
    // This also keeps MG1 off api/bookings/route.ts, shared with #2265.
    expect(callersOf("resolveLinkedBookingMembersWithBoundary")).toEqual([]);
    for (const file of CALL_SITE_FILES) {
      expect(readRepoFile(file)).not.toContain("resolveLinkedBookingMembersWithBoundary");
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

describe("nothing in this release can write a non-null consentStatus", () => {
  it("keeps the widening predicate off", () => {
    // E.22's target. MG2 flips this; when it does, the ON/OFF matrix and the
    // beyond-family refusal above all fail, which is the intended alarm.
    expect(MEMBER_GUEST_WIDENING_ENABLED).toBe(false);
  });

  it("declares the only consent shape a guest row can carry today", () => {
    // A.3. Family adds are consent-FREE, not consent-GIVEN: null must never be
    // written as CONFIRMED, or MG2/MG4 lose the ability to tell "nobody had to
    // be asked" from "somebody said yes".
    expect(CONSENT_FREE_GUEST_COLUMNS).toEqual({
      consentStatus: null,
      consentRequestedAt: null,
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
      consentExpiresAt: null,
    });
  });

  it("has no production file outside the allowlist that even names a consent column", () => {
    // Layer one of two. The previous single sweep looked for `consentX\s*:`,
    // which saw an object-literal property and nothing else: planted mutants
    // writing `guest.consentStatus = "PENDING"`, `data["consentStatus"] = x`,
    // and a raw-SQL `SET "consentStatus" = 'PENDING'` all passed it. This layer
    // is deliberately blunt instead — a BARE-WORD match on the column names —
    // so any new file that so much as mentions one has to be classified here.
    const offenders = productionFilesUnder("src")
      .filter((file) => !CONSENT_COLUMN_ALLOWLIST.has(file))
      .filter((file) => CONSENT_COLUMN_MENTION.test(readRepoFile(file)));
    expect(offenders).toEqual([]);
  });

  it("has no production line anywhere that gives a consent column a value", () => {
    // Layer two: even the three allowlisted files may not WRITE one. The
    // pattern catches the property form, a bare assignment, a computed or
    // quoted key, and the raw-SQL form, while `=== null` / `!== null`
    // comparisons and destructuring are not matches. member-guest-consent.ts
    // is the one file that legitimately contains write-shaped lines, and it is
    // checked below rather than skipped.
    const offenders = productionFilesUnder("src")
      .filter((file) => file !== "src/lib/member-guest-consent.ts")
      .filter((file) => CONSENT_COLUMN_WRITE.test(readRepoFile(file)));
    expect(offenders).toEqual([]);
  });

  it("writes nothing but null even inside the consent model itself", () => {
    // Not "skip the model's own file" — that is where a writer would hide. The
    // five type-declaration lines are identified as such, and every OTHER
    // value-position occurrence in the file must be `null`, i.e. must be part
    // of CONSENT_FREE_GUEST_COLUMNS.
    const source = readRepoFile("src/lib/member-guest-consent.ts");
    const declarationAt = source.indexOf("export interface MemberGuestConsentColumns {");
    expect(declarationAt).toBeGreaterThan(-1);
    const declarationEnd = source.indexOf("}", declarationAt);
    const declaration = source.slice(declarationAt, declarationEnd);
    const rest = source.slice(0, declarationAt) + source.slice(declarationEnd);

    // The declaration names all five columns, each of them nullable.
    for (const column of CONSENT_COLUMNS) {
      expect(declaration, column).toMatch(new RegExp(`${column}:[^;]*\\| null;`));
    }

    const writes = [
      ...rest.matchAll(new RegExp(`${CONSENT_COLUMN_WRITE.source}\\s*([^,;\\n]*)`, "g")),
    ];
    expect(writes).toHaveLength(CONSENT_COLUMNS.length);
    for (const write of writes) {
      expect(write[1].trim(), write[0]).toBe("null");
    }
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

  it("is read by no production code at all", () => {
    // D.20. Until MG3 ships the type-ahead, the ONLY files allowed to name
    // these columns are the schema, the shared defaults, the loader that fills
    // them in, and the config-transfer spec that refuses to export them.
    const allowed = new Set([
      "src/config/club-settings-defaults.ts",
      "src/lib/member-guest-settings.ts",
      "src/lib/config-transfer/categories/club-settings.ts",
    ]);
    const readers = sourceFilesUnder("src")
      .filter((file) => !file.includes("__tests__"))
      .filter((file) => !allowed.has(file.replace(/\\/g, "/")))
      .filter((file) => /openMemberSearch/.test(readRepoFile(file)));
    expect(readers).toEqual([]);
  });
});

describe("the module flag itself gates nothing yet", () => {
  it("is a real module key with no reader in the booking path", () => {
    expect(MODULE_KEYS).toContain("memberGuests");
    // Deliberate: the refusal is gated on MEMBER_GUEST_WIDENING_ENABLED, never
    // on the module. If a `memberGuests` module check appears in a booking
    // path, module-on becomes observable and the whole matrix above is void.
    const readers = sourceFilesUnder("src")
      .filter((file) => !file.includes("__tests__"))
      .filter((file) => /isEffectiveModuleEnabled\(\s*["']memberGuests["']/.test(readRepoFile(file)));
    expect(readers).toEqual([]);
  });

  it("tells an admin plainly that the switch does nothing yet (D-17)", () => {
    const definition = MODULE_DEFINITIONS.memberGuests;
    expect(definition.key).toBe("memberGuests");
    expect(definition.label.length).toBeGreaterThan(0);
    // The DESCRIPTION has to say it too, not just the dependency note: it is the
    // first line on the card, above the badge and the note.
    expect(definition.description).toMatch(/^Not available yet — /);
    expect(definition.dependencies.join(" ")).toMatch(/not available yet/i);
  });

  it("never reports itself ready, even switched on (D-17)", () => {
    // The stub module is the one place an admin can SEE this feature, so it must
    // not look live. Without this, switching it on produced the ordinary
    // "... is enabled." message and a green badge over a feature that cannot
    // run — which is what made the CHANGELOG and CONFIGURATION sentences about
    // the switch saying so "plainly" not quite true as written.
    const statusFor = (memberGuests: boolean) => {
      const module = buildClubModuleSettingsPayload({ memberGuests }).modules.find(
        (entry) => entry.key === "memberGuests",
      );
      expect(module, "memberGuests missing from the module payload").toBeDefined();
      return module!;
    };

    expect(statusFor(false).readiness.status).toBe("admin_disabled");

    const on = statusFor(true);
    expect(on.adminEnabled).toBe(true);
    expect(on.readiness.status).toBe("not_available_yet");
    expect(on.readiness.message).toMatch(/not available in this version/i);
    expect(on.readiness.status).not.toBe("ready");

    // ...and the branch is one module wide, not a blanket over the registry: an
    // ordinary credential-free module switched on is still "ready".
    const notices = buildClubModuleSettingsPayload({ memberNotices: true }).modules.find(
      (entry) => entry.key === "memberNotices",
    );
    expect(notices!.readiness.status).toBe("ready");
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
