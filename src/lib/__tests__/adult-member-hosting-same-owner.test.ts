// #2576 — the `SAME_BOOKING_OWNER` host scope: which OTHER booking may supply an
// adult member, and what happens when a change takes that cover away.
//
// The owner's decision is almost entirely about a RELATIONSHIP, so most of these
// tests are about which bookings are and are not related. A test double that
// ignored the `where` clauses would pass every one of them for the wrong reason, so
// the fake store below really applies them — see `matchesWhere`. That is the whole
// reason this file does not reuse the single-row `makeDb` in
// adult-member-hosting-review.test.ts.
import { AgeTier, type MemberGuestConsentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  evaluateBookingAdultMemberHosting,
  reconcileSameOwnerCoverageIncident,
  reconcileAdultMemberHostingReviewWithSiblings,
  hostingCoverageActorOptions,
  loadSameOwnerCoverageDependentIds,
} from "@/lib/adult-member-hosting-review";
import { hostingCoverageStateKey } from "@/lib/adult-member-hosting-coverage-incidents";
import {
  SameOwnerCoverageWouldBreakError,
  formatStrandedCoverageMessage,
  sameBookingOwnerCoverageSourceWhere,
  sameOwnerCoverageDependentWhere,
} from "@/lib/adult-member-hosting-same-owner";

const LODGE = "lodge-a";
const OTHER_LODGE = "lodge-b";

/** A club-wide policy row. `ENFORCED` + both scopes unless overridden. */
function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-club",
    scopeKey: "club-wide",
    lodgeId: null,
    mode: "ENFORCED",
    capacityMode: "NO_HOLD",
    version: 7,
    hostScopeSameBooking: true,
    hostScopeSameBookingOwner: true,
    ...overrides,
  };
}

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "adult-1",
    ageTier: AgeTier.ADULT,
    active: true,
    cancelledAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function guestRow(
  id: string,
  nights: string[],
  member: ReturnType<typeof memberRow> | null = null,
  consentStatus: MemberGuestConsentStatus | null = null,
) {
  return {
    id,
    firstName: id,
    lastName: "Person",
    memberId: member?.id ?? null,
    stayStart: new Date(`${nights[0]}T00:00:00.000Z`),
    stayEnd: new Date(`${nights[nights.length - 1]}T00:00:00.000Z`),
    consentStatus,
    nights: nights.map((night) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) })),
    member,
  };
}

type FakeBooking = Record<string, unknown>;

/**
 * A booking row with every column the coverage predicates read, plus the three the
 * owner's decision says must NOT link bookings (`createdById`, `memberEmail`,
 * `familyGroupId`). They are here so the "does not link" tests can set them
 * identically on two rows and still expect no coverage — a store that did not carry
 * them could not tell the difference between "the predicate ignores this column"
 * and "the column was never there".
 */
function booking(overrides: FakeBooking = {}): FakeBooking {
  return {
    id: "b-main",
    memberId: "owner-1",
    parentBookingId: null,
    lodgeId: LODGE,
    status: "CONFIRMED",
    deletedAt: null,
    createdById: "admin-1",
    memberEmail: "owner@example.test",
    familyGroupId: "family-1",
    checkIn: new Date("2026-07-03T00:00:00.000Z"),
    checkOut: new Date("2026-07-05T00:00:00.000Z"),
    adultMemberHostingReview: null,
    adultMemberHostingReviewStatus: null,
    guests: [],
    ...overrides,
  };
}

/**
 * Apply a Prisma-shaped `where` to a plain row.
 *
 * Supports exactly the operators the coverage predicates use — equality, `not`,
 * `in`, `notIn`, `lt`, `gt`, and a top-level `OR` — and THROWS on anything else.
 * Throwing rather than ignoring is deliberate: a clause this fake silently skipped
 * would make a "not related" test pass while the production query related the two
 * bookings.
 */
function matchesWhere(row: FakeBooking, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    const value = row[key];
    if (condition === null || typeof condition !== "object") {
      if (value !== condition) return false;
      continue;
    }
    const operators = condition as Record<string, unknown>;
    for (const [operator, operand] of Object.entries(operators)) {
      switch (operator) {
        case "not":
          if (value === operand) return false;
          break;
        case "in":
          if (!(operand as unknown[]).includes(value)) return false;
          break;
        case "notIn":
          if ((operand as unknown[]).includes(value)) return false;
          break;
        case "lt":
          if (!((value as Date) < (operand as Date))) return false;
          break;
        case "gt":
          if (!((value as Date) > (operand as Date))) return false;
          break;
        default:
          throw new Error(`fake store cannot apply operator ${operator}`);
      }
    }
  }
  return true;
}

/**
 * A whole club behind one fake client: bookings that answer the real predicates,
 * a policy row, a lodge name, an incident table and a re-evaluation queue.
 */
function makeStore(
  rows: FakeBooking[],
  options: {
    policies?: unknown[];
    incidents?: Array<{ id: string; bookingId: string; stateKey: string }>;
  } = {},
) {
  const byId = new Map(rows.map((row) => [row.id as string, { ...row }]));
  const queued: Array<Record<string, unknown>> = [];
  const incidents = [...(options.incidents ?? [])];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

  const db = {
    booking: {
      findUnique: vi.fn(async ({ where }: any) => byId.get(where.id) ?? null),
      findMany: vi.fn(async ({ where, select }: any) => {
        const matched = [...byId.values()].filter((row) =>
          matchesWhere(row, where),
        );
        // The same-owner SOURCE read narrows the guest relation to member-linked
        // rows. Honour it: a fake that returned non-member guests too would hide a
        // loader that had stopped narrowing.
        const guestWhere = select?.guests?.where;
        if (!guestWhere) return matched;
        return matched.map((row) => ({
          ...row,
          guests: (row.guests as Array<Record<string, unknown>>).filter((guest) =>
            matchesWhere(guest, guestWhere),
          ),
        }));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(byId.get(where.id)!, data);
        updates.push({ id: where.id, data });
        return {};
      }),
    },
    adultMemberHostingPolicy: {
      findMany: vi.fn().mockResolvedValue(options.policies ?? [policyRow()]),
    },
    lodge: { findFirst: vi.fn().mockResolvedValue({ name: "Ruapehu Lodge" }) },
    member: { findMany: vi.fn().mockResolvedValue([]) },
    hostingCoverageIncident: {
      findMany: vi.fn(async ({ where }: any) =>
        incidents.filter((incident) =>
          Array.isArray(where.bookingId?.in)
            ? where.bookingId.in.includes(incident.bookingId)
            : true,
        ),
      ),
      findFirst: vi.fn(async ({ where }: any) =>
        incidents.find((incident) => incident.bookingId === where.bookingId) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const created = { id: `incident-${incidents.length + 1}`, ...data };
        incidents.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(incidents.find((row: any) => row.id === where.id)!, data);
        return {};
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matched = (incidents as any[]).filter(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.bookingId === undefined || row.bookingId === where.bookingId) &&
            (where.resolvedAt !== null || row.resolvedAt == null) &&
            (where.NOT?.notifiedStateKey === undefined ||
              row.notifiedStateKey !== where.NOT.notifiedStateKey),
        );
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      }),
    },
    hostingCoverageReevaluation: {
      create: vi.fn(async ({ data }: any) => {
        queued.push({ id: `queue-${queued.length + 1}`, attempts: 0, ...data });
        return { id: `queue-${queued.length}` };
      }),
      findMany: vi.fn(async ({ take }: any) =>
        queued
          .filter((item) => item.processedAt == null)
          .slice(0, take)
          .map((item) => ({ ...item })),
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = queued.find((item) => item.id === where.id);
        if (!row || row.processedAt != null) return { count: 0 };
        if (where.attempts !== undefined && row.attempts !== where.attempts) {
          return { count: 0 };
        }
        for (const [key, value] of Object.entries(data)) {
          row[key] =
            value && typeof value === "object" && "increment" in (value as any)
              ? (row[key] as number) + (value as any).increment
              : value;
        }
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  } as any;

  db.__rows = byId;
  return { db, queued, incidents, updates, rowFor: (id: string) => byId.get(id)! };
}

/** The main booking: two non-member guest-nights, nobody on it to host them. */
function mainWithTwoUncoveredNights(overrides: FakeBooking = {}) {
  return booking({
    guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
    ...overrides,
  });
}

/** A source booking with a qualifying adult member attending `nights`. */
function sourceWithAdult(
  id: string,
  nights: string[],
  overrides: FakeBooking = {},
) {
  return booking({
    id,
    checkIn: new Date(`${nights[0]}T00:00:00.000Z`),
    checkOut: new Date(
      new Date(`${nights[nights.length - 1]}T00:00:00.000Z`).getTime() + 86400000,
    ),
    guests: [guestRow("adult", nights, memberRow({ id: `adult-${id}` }))],
    ...overrides,
  });
}

async function uncoveredNights(rows: FakeBooking[], policies?: unknown[]) {
  const { db } = makeStore(rows, policies ? { policies } : {});
  const { violation } = await evaluateBookingAdultMemberHosting(
    rows[0] as never,
    db,
  );
  return violation?.affectedNights ?? [];
}

describe("the relationship is the exact Booking.memberId and nothing else (#2576 §1)", () => {
  it("names only the owner, the lodge, the lifecycle and the dates", () => {
    // The structural half of §1's list. Behaviour tests below prove each column is
    // not consulted; this proves none of them is even mentioned, so a future edit
    // cannot reintroduce one by adding a clause nobody tests.
    const forbidden = [
      "createdById",
      "email",
      "familyGroup",
      "parentBookingId",
      "organiser",
      "payment",
    ];
    const source = JSON.stringify(
      sameBookingOwnerCoverageSourceWhere(booking() as never),
    );
    const dependent = JSON.stringify(
      sameOwnerCoverageDependentWhere(booking() as never),
    );
    for (const column of forbidden) {
      expect(source, column).not.toContain(column);
      expect(dependent, column).not.toContain(column);
    }
    expect(Object.keys(sameOwnerCoverageDependentWhere(booking() as never)).sort())
      .toEqual([
        "checkIn",
        "checkOut",
        "deletedAt",
        "id",
        "lodgeId",
        "memberId",
        "status",
      ]);
  });

  it("covers a night from another booking with the same memberId", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"]),
      ]),
    ).toEqual([]);
  });

  it("does not cover from a booking with a different memberId", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not link two bookings by createdById", async () => {
    // The administrator who keyed both bookings in is the SAME person; the members
    // they were keyed in for are not. §1 says in as many words that this must not
    // relate them.
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights({ createdById: "officer-9" }),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
          createdById: "officer-9",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not link two bookings by matching email address", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights({ memberEmail: "shared@example.test" }),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
          memberEmail: "shared@example.test",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not link two bookings by Family Group membership alone", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights({ familyGroupId: "family-7" }),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
          familyGroupId: "family-7",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not link a parent and child booking owned by different members", async () => {
    // A group joiner's booking hangs off the organiser's. `parentBookingId` alone
    // must not relate them, and the split-sibling borrow is same-member too, so
    // NEITHER half of the rule may reach across the two accounts.
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights({ parentBookingId: "b-other" }),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });
});

describe("the same lodge and the exact night (#2576 §4)", () => {
  it("does not cover from the same owner at a different lodge", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          lodgeId: OTHER_LODGE,
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not cover a night the source's adult member is not staying", async () => {
    // Overlapping stays, so the envelope clause admits the source; the per-night
    // decision still refuses, because the adult member's own guest-nights are what
    // count. This is the test that would pass on a booking-range implementation and
    // must not.
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        booking({
          id: "b-other",
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
          guests: [guestRow("adult", ["2026-07-04"], memberRow())],
        }),
      ]),
    ).toEqual(["2026-07-03"]);
  });

  it("reports exactly the uncovered nights of a partially covered stay", async () => {
    expect(
      await uncoveredNights([
        booking({
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-06T00:00:00.000Z"),
          guests: [guestRow("kid", ["2026-07-03", "2026-07-04", "2026-07-05"])],
        }),
        sourceWithAdult("b-other", ["2026-07-04"]),
      ]),
    ).toEqual(["2026-07-03", "2026-07-05"]);
  });

  it("records which scope covered each night in the evidence (#2576 §5)", async () => {
    const rows = [
      booking({
        checkIn: new Date("2026-07-03T00:00:00.000Z"),
        checkOut: new Date("2026-07-06T00:00:00.000Z"),
        guests: [
          guestRow("kid", ["2026-07-03", "2026-07-04", "2026-07-05"]),
          // On the booking itself, so 07-05 is same-booking cover.
          guestRow("own-adult", ["2026-07-05"], memberRow({ id: "adult-own" })),
        ],
      }),
      sourceWithAdult("b-other", ["2026-07-04"]),
    ];
    const { db } = makeStore(rows);
    const { violation } = await evaluateBookingAdultMemberHosting(
      rows[0] as never,
      db,
    );
    const byNight = new Map(
      violation!.requirements.qualifyingHostsByNight.map((row) => [
        row.night,
        row.coveredByScopes,
      ]),
    );
    expect(byNight.get("2026-07-03")).toEqual([]);
    expect(byNight.get("2026-07-04")).toEqual(["SAME_BOOKING_OWNER"]);
    expect(byNight.get("2026-07-05")).toEqual(["SAME_BOOKING"]);
    expect(violation!.affectedNights).toEqual(["2026-07-03"]);
  });
});

describe("who may host, and ownership is never attendance (#2576 §2)", () => {
  it("accepts a qualifying adult member who is not the booking owner", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        booking({
          id: "b-other",
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
          // A friend of the family, not the account holder.
          guests: [
            guestRow(
              "friend",
              ["2026-07-03", "2026-07-04"],
              memberRow({ id: "adult-friend" }),
            ),
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it("refuses a source booking that has no attending adult member", async () => {
    // Owned by an adult member, and that is all. §2: "booking ownership by itself is
    // never attendance evidence."
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        booking({
          id: "b-other",
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
          guests: [guestRow("their-kid", ["2026-07-03", "2026-07-04"])],
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("refuses a source adult whose membership has lapsed or been archived", async () => {
    for (const lapse of [
      { active: false },
      { cancelledAt: new Date("2026-06-01T00:00:00.000Z") },
      { archivedAt: new Date("2026-06-01T00:00:00.000Z") },
      { ageTier: AgeTier.CHILD },
    ]) {
      expect(
        await uncoveredNights([
          mainWithTwoUncoveredNights(),
          booking({
            id: "b-other",
            checkIn: new Date("2026-07-03T00:00:00.000Z"),
            checkOut: new Date("2026-07-05T00:00:00.000Z"),
            guests: [
              guestRow(
                "adult",
                ["2026-07-03", "2026-07-04"],
                memberRow({ id: "adult-x", ...lapse }),
              ),
            ],
          }),
        ]),
        JSON.stringify(lapse),
      ).toEqual(["2026-07-03", "2026-07-04"]);
    }
  });

  it("refuses a source adult whose member-guest consent is not settled", async () => {
    // D-12: a member guest who has not accepted is not operationally present, so
    // they are not at the lodge and cannot host. Losing consent therefore removes
    // cover, which is what makes it one of §6's change classes.
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        booking({
          id: "b-other",
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
          guests: [
            guestRow(
              "adult",
              ["2026-07-03", "2026-07-04"],
              memberRow({ id: "adult-x" }),
              "PENDING" as MemberGuestConsentStatus,
            ),
          ],
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("never counts the source's own guest-nights as this booking's problem (§15)", async () => {
    // The adult arrives as a `hostOnly` participant, so their attendance is
    // evidence and nothing else: they are not duplicated as a guest of this
    // booking, and no bed is counted twice. A non-member guest on the SOURCE
    // booking is likewise that booking's own question.
    const rows = [
      mainWithTwoUncoveredNights(),
      booking({
        id: "b-other",
        checkIn: new Date("2026-07-03T00:00:00.000Z"),
        checkOut: new Date("2026-07-05T00:00:00.000Z"),
        guests: [
          guestRow("adult", ["2026-07-03", "2026-07-04"], memberRow()),
          guestRow("their-kid", ["2026-07-03", "2026-07-04"]),
        ],
      }),
    ];
    const { db } = makeStore(rows);
    const { violation } = await evaluateBookingAdultMemberHosting(
      rows[0] as never,
      db,
    );
    expect(violation).toBeNull();
  });
});

describe("only confirmed active attendance may supply cover (#2576 §3)", () => {
  const EXCLUDED = [
    "DRAFT",
    "PENDING",
    "PAYMENT_PENDING",
    "AWAITING_REVIEW",
    "WAITLISTED",
    "WAITLIST_OFFERED",
    "BUMPED",
    "CANCELLED",
    "COMPLETED",
  ];

  it.each(EXCLUDED)("refuses a %s source booking", async (status) => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], { status }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it.each(["CONFIRMED", "PAID"])("accepts a %s source booking", async (status) => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], { status }),
      ]),
    ).toEqual([]);
  });

  it("refuses an archived (soft-deleted) source booking", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          deletedAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });
});

describe("the scope is opt-in (#2576 §12, §13)", () => {
  it("ignores another same-owner booking while the scope is off", async () => {
    expect(
      await uncoveredNights(
        [
          mainWithTwoUncoveredNights(),
          sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"]),
        ],
        [policyRow({ hostScopeSameBookingOwner: false })],
      ),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("still satisfies the policy from the same booking with the scope off", async () => {
    expect(
      await uncoveredNights(
        [
          booking({
            guests: [
              guestRow("kid", ["2026-07-03", "2026-07-04"]),
              guestRow("adult", ["2026-07-03", "2026-07-04"], memberRow()),
            ],
          }),
        ],
        [policyRow({ hostScopeSameBookingOwner: false })],
      ),
    ).toEqual([]);
  });

  it("costs no same-owner query while the scope is off", async () => {
    const rows = [
      mainWithTwoUncoveredNights(),
      sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"]),
    ];
    const { db } = makeStore(rows, {
      policies: [policyRow({ hostScopeSameBookingOwner: false })],
    });
    await evaluateBookingAdultMemberHosting(rows[0] as never, db);
    // One read only: the split-sibling borrow, which predates this scope.
    expect(db.booking.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("a change that would strand another booking (#2576 §6, §7, §14)", () => {
  /** The nights `b-main`'s non-member child stays in the pair below. */
  const KID_NIGHTS_FOR_STRANDING = ["2026-07-03", "2026-07-04"];

  /**
   * What `b-source` is left carrying once the adult member has gone: a MEMBER child.
   *
   * Deliberately a member rather than a plain guest, so `b-source` has no uncovered
   * non-member guest-night of its OWN. Otherwise #2569's enforced refusal fires for
   * `b-source` itself before the same-owner question is ever reached, and every test
   * below would pass on the wrong error.
   */
  const REMAINING_MEMBER_CHILD = guestRow(
    "their-child",
    ["2026-07-03", "2026-07-04"],
    memberRow({ id: "member-child", ageTier: AgeTier.CHILD }),
  );

  /**
   * The account holds two bookings at one lodge over the same two nights: `b-main`
   * carries a non-member child, `b-source` carries the adult member covering them.
   * Removing the adult from `b-source` is the shape §6 is about.
   */
  function strandingPair(sourceGuests: Array<Record<string, unknown>>) {
    return [
      booking({
        id: "b-source",
        guests: sourceGuests,
      }),
      booking({
        id: "b-main",
        guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
      }),
    ];
  }

  it("refuses an ordinary member's change and names their own booking and nights", async () => {
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    const { db, queued } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).rejects.toBeInstanceOf(SameOwnerCoverageWouldBreakError);

    // Nothing was queued: the throw rolls the caller's transaction back, so a queue
    // row would describe work for a change that never happened.
    expect(queued).toEqual([]);

    // Caught rather than asserted through `rejects`, because the body of the
    // refusal — the member's own bookings, lodge and nights — is the point.
    let error: SameOwnerCoverageWouldBreakError | null = null;
    try {
      await reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "MEMBER",
          actorMemberId: "owner-1",
        }),
      );
    } catch (err) {
      error = err as SameOwnerCoverageWouldBreakError;
    }
    expect(error).toBeInstanceOf(SameOwnerCoverageWouldBreakError);
    if (error === null) throw new Error("unreachable");
    expect(error.status).toBe(409);
    expect(error.code).toBe("SAME_OWNER_COVERAGE_WOULD_BREAK");
    expect(error.stranded).toHaveLength(1);
    expect(error.stranded[0]).toMatchObject({
      bookingId: "b-main",
      lodgeName: "Ruapehu Lodge",
      nights: ["2026-07-03", "2026-07-04"],
    });
    expect(error.message).toContain(
      "This change would leave another booking on your account without the " +
        "required adult member coverage",
    );
    expect(error.message).toContain("Ruapehu Lodge");
  });

  it("allows a member's change that leaves alternative coverage (§14)", async () => {
    const rows = [
      ...strandingPair([guestRow("nobody", ["2026-07-03"])]),
      // A SECOND eligible source still covering both nights.
      sourceWithAdult("b-spare", ["2026-07-03", "2026-07-04"]),
    ];
    const { db, queued } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).resolves.toBeTruthy();
    // Existential coverage: nothing stranded, nothing to settle, no queue row, so
    // no incident and no misleading loss-of-cover email.
    expect(queued).toEqual([]);
  });

  it("does not refuse over a hazard the change did not cause", async () => {
    // `b-main` is uncovered before and after: an unrelated edit to `b-source` cannot
    // fix it, so refusing would trap the member on every future edit.
    const rows = [
      booking({ id: "b-source", guests: [REMAINING_MEMBER_CHILD] }),
      booking({
        id: "b-main",
        guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
        adultMemberHostingReviewStatus: "PENDING",
        adultMemberHostingReview: {
          reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
          policyId: "policy-club",
          policyVersion: 7,
          affectedNights: ["2026-07-03", "2026-07-04"],
          requirements: {
            uncovered: [
              { guestRef: "kid", guestName: "kid Person", night: "2026-07-03" },
              { guestRef: "kid", guestName: "kid Person", night: "2026-07-04" },
            ],
          },
        },
      }),
    ];
    const { db } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).resolves.toBeTruthy();
  });

  it("does not refuse over a hazard recorded ONLY on an open incident", async () => {
    // The sibling of the test above, and a DIFFERENT branch of the same comparison.
    // A dependent whose cover was removed by an officer last week carries an open
    // INCIDENT, and its review snapshot may have been cleared or reset since — the
    // incident is what survives a review reset, which is the whole reason it exists
    // as a separate row. Refusing today's unrelated member edit over it would trap
    // them exactly as the stored-snapshot case would.
    //
    // Mutation-found: dropping the incident half of the comparison left every other
    // test in this file green.
    const rows = [
      booking({ id: "b-source", guests: [REMAINING_MEMBER_CHILD] }),
      booking({
        id: "b-main",
        guests: [guestRow("kid", KID_NIGHTS_FOR_STRANDING)],
      }),
    ];
    const { db } = makeStore(rows);
    // Evaluate the dependent exactly as the reconciler will, so the seeded incident
    // carries the key its CURRENT uncovered state produces — an independently
    // written literal would only prove the two happened to differ.
    const { violation } = await evaluateBookingAdultMemberHosting(
      rows[1] as never,
      db,
    );
    expect(violation).not.toBeNull();
    const seeded = makeStore(rows, {
      incidents: [
        {
          id: "incident-1",
          bookingId: "b-main",
          stateKey: hostingCoverageStateKey(violation!),
        },
      ],
    });
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        seeded.db,
        hostingCoverageActorOptions({ actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).resolves.toBeTruthy();
    // The change is permitted, AND the standing incident is still queued for
    // re-examination — that arm is what closes it if cover ever comes back.
    expect(seeded.queued).toHaveLength(1);
  });

  it("allows an officer's change and records the bounded work instead (§7, §8)", async () => {
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    const { db, queued } = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      db,
      hostingCoverageActorOptions({
        actorRole: "ADMIN",
        actorMemberId: "officer-1",
        reason: "Member rang; taking the adult off at their request",
      }),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      memberId: "owner-1",
      lodgeId: LODGE,
      cause: "OFFICER_OVERRIDE",
      actorMemberId: "officer-1",
      sourceBookingId: "b-source",
    });
    // Bounded to the nights this booking actually touched (§10).
    expect(queued[0].nights).toEqual(["2026-07-03", "2026-07-04"]);
    expect(queued[0].reason).toContain("Member rang");
    // NO AUTOMATIC CANCELLATION anywhere (§7, §16): nothing wrote a booking status.
    expect(
      db.booking.update.mock.calls.some((call: any) => "status" in call[0].data),
    ).toBe(false);
  });

  it("refuses to record an officer override with no reason (§7)", async () => {
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    const { db, queued } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings("b-source", db, {
        dependentCoverage: "ESCALATE",
        coverageChange: { cause: "OFFICER_OVERRIDE", actorMemberId: "officer-1" },
      }),
    ).rejects.toThrow(/requires an explicit reason/);
    expect(queued).toEqual([]);
  });

  it("records an unexplained officer change honestly, as a system change", () => {
    // §7 makes a reason mandatory, so a surface that captured none has not taken an
    // override — and recording it AS one, with an invented reason, would be worse
    // than recording what actually happened.
    expect(
      hostingCoverageActorOptions({ actorRole: "ADMIN", actorMemberId: "officer-1" }),
    ).toEqual({
      dependentCoverage: "ESCALATE",
      coverageChange: {
        cause: "SYSTEM_CHANGE",
        actorMemberId: "officer-1",
        reason: null,
      },
    });
    expect(hostingCoverageActorOptions({ actorRole: "MEMBER" })).toEqual({
      dependentCoverage: "BLOCK",
    });
    // A delegated bookings-edit permission is officer authority too.
    expect(
      hostingCoverageActorOptions({
        actorRole: "MEMBER",
        hasBookingsEditAccess: true,
      }).dependentCoverage,
    ).toBe("ESCALATE");
  });

  it("queues the resolution when a change RESTORES another booking's cover", async () => {
    // `b-main` carries an open incident and is now covered again. Even under BLOCK —
    // a member fixing the problem themselves — the incident must be re-examined, or
    // it stands forever because the fix was permitted.
    const rows = [
      sourceWithAdult("b-source", ["2026-07-03", "2026-07-04"]),
      booking({
        id: "b-main",
        guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
      }),
    ];
    const { db, queued } = makeStore(rows, {
      incidents: [{ id: "incident-1", bookingId: "b-main", stateKey: "v1:old" }],
    });
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      db,
      hostingCoverageActorOptions({ actorRole: "MEMBER", actorMemberId: "owner-1" }),
    );
    expect(queued).toHaveLength(1);
  });

  it("does nothing at all while the club is only reviewing, not enforcing", async () => {
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    const { db, queued } = makeStore(rows, {
      policies: [policyRow({ mode: "ADMIN_REVIEW_REQUIRED" })],
    });
    // An uncovered booking is a permitted state with a pending review under this
    // consequence, so neither a refusal nor a second officer-facing incident is
    // something the club asked for.
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).resolves.toBeTruthy();
    expect(queued).toEqual([]);
  });
});

describe("privacy: the member sees their own account and nothing else (#2576 §11)", () => {
  it("names no person in the refusal, only the member's own bookings", () => {
    const message = formatStrandedCoverageMessage([
      {
        bookingId: "b-main",
        reference: "BK-ABC123",
        lodgeName: "Ruapehu Lodge",
        nights: ["2026-07-03"],
      },
    ]);
    expect(message).toContain("BK-ABC123");
    expect(message).toContain("Ruapehu Lodge");
    expect(message).not.toContain("adult-");
    expect(message).not.toContain("owner-");
    expect(message).not.toContain("@");
  });

  it("cannot reach a booking on another account, because the predicate cannot", () => {
    // The privacy boundary is the `where` itself rather than a filter applied
    // afterwards, which is why it is asserted here rather than on a response body.
    const where = sameOwnerCoverageDependentWhere(booking() as never) as any;
    expect(where.memberId).toBe("owner-1");
    expect(typeof where.memberId).toBe("string");
  });
});

describe("the re-evaluation bound is a property of the item (#2576 §10)", () => {
  it("reads only that owner, that lodge and those nights", async () => {
    const rows = [
      booking({ id: "b-main" }),
      booking({ id: "b-other-owner", memberId: "owner-2" }),
      booking({ id: "b-other-lodge", lodgeId: OTHER_LODGE }),
      booking({
        id: "b-other-nights",
        checkIn: new Date("2026-08-03T00:00:00.000Z"),
        checkOut: new Date("2026-08-05T00:00:00.000Z"),
      }),
    ];
    const { db } = makeStore(rows);
    expect(
      await loadSameOwnerCoverageDependentIds(
        { memberId: "owner-1", lodgeId: LODGE, nights: ["2026-07-03", "2026-07-04"] },
        db,
      ),
    ).toEqual(["b-main"]);
  });

  it("treats an item with no nights as no work", async () => {
    const { db } = makeStore([booking()]);
    expect(
      await loadSameOwnerCoverageDependentIds(
        { memberId: "owner-1", lodgeId: LODGE, nights: [] },
        db,
      ),
    ).toEqual([]);
    expect(db.booking.findMany).not.toHaveBeenCalled();
  });

  it("includes a booking arriving on the item's last night and not the morning after", async () => {
    const rows = [
      booking({
        id: "b-last-night",
        checkIn: new Date("2026-07-04T00:00:00.000Z"),
        checkOut: new Date("2026-07-05T00:00:00.000Z"),
      }),
      booking({
        id: "b-morning-after",
        checkIn: new Date("2026-07-05T00:00:00.000Z"),
        checkOut: new Date("2026-07-06T00:00:00.000Z"),
      }),
    ];
    const { db } = makeStore(rows);
    expect(
      await loadSameOwnerCoverageDependentIds(
        { memberId: "owner-1", lodgeId: LODGE, nights: ["2026-07-03", "2026-07-04"] },
        db,
      ),
    ).toEqual(["b-last-night"]);
  });
});

/** The live booking row inside a fake store, for asserting what was written. */
function rowFromStore(db: any, id: string): Record<string, unknown> {
  return db.__rows.get(id) as Record<string, unknown>;
}

describe("settling a dependent booking after the change (#2576 §7, §14, §16)", () => {
  const KID_NIGHTS = ["2026-07-03", "2026-07-04"];

  it("opens ONE urgent incident and never touches the booking's lifecycle", async () => {
    const rows = [
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
    ];
    const { db, incidents } = makeStore(rows);
    const first = await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    expect(first.action).toBe("opened");
    // Idempotent: the drain is at-least-once, so the same facts must write nothing
    // the second time and must not notify again.
    const second = await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    expect(second.action).toBe("unchanged");
    expect(incidents).toHaveLength(1);
    // §7 and §16 both forbid automatic cancellation: beds and payments stay.
    expect(
      db.booking.update.mock.calls.some((call: any) => "status" in call[0].data),
    ).toBe(false);
    // The booking's own review IS recorded, so its page and the officer's booking
    // view agree with the incident.
    expect(rowFromStore(db, "b-main").adultMemberHostingReviewStatus).toBe("PENDING");
  });

  it("resolves rather than opens when an alternative same-owner source covers it (§14)", async () => {
    const rows = [
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
      sourceWithAdult("b-spare", KID_NIGHTS),
    ];
    const { db, incidents } = makeStore(rows, {
      incidents: [{ id: "incident-1", bookingId: "b-main", stateKey: "v1:old" }],
    });
    const outcome = await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    // No false incident, no misleading loss-of-cover email, and the standing
    // incident is closed with the reason an officer can read.
    expect(outcome.action).toBe("resolved");
    expect((incidents[0] as Record<string, unknown>).resolution).toBe(
      "COVERAGE_RESTORED",
    );
  });

  it("opens nothing for a booking the club has not confirmed", async () => {
    // The saved-card auto-charge claims PENDING -> CONFIRMED, queues this work, and
    // releases the claim if the charge fails. Arriving after that release must not
    // put a stay nobody confirmed in front of an officer as an emergency.
    for (const status of ["PENDING", "DRAFT", "AWAITING_REVIEW", "WAITLISTED"]) {
      const { db, incidents } = makeStore([
        booking({ id: "b-main", status, guests: [guestRow("kid", KID_NIGHTS)] }),
      ]);
      const outcome = await reconcileSameOwnerCoverageIncident(
        { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
        db,
      );
      expect(outcome.action, status).toBe("none");
      expect(incidents, status).toEqual([]);
    }
  });

  it("closes an incident when the club stops enforcing", async () => {
    const { db, incidents } = makeStore(
      [booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] })],
      {
        policies: [policyRow({ mode: "ADMIN_REVIEW_REQUIRED" })],
        incidents: [{ id: "incident-1", bookingId: "b-main", stateKey: "v1:old" }],
      },
    );
    const outcome = await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    // An incident is the ENFORCED instrument; under review mode the pending review
    // is already the officer's signal, so a row they can do nothing with is closed.
    expect(outcome.action).toBe("resolved");
    expect(incidents[0]).toMatchObject({ resolution: "COVERAGE_RESTORED" });
  });

  it("records the officer's reason on the incident it opens (§7)", async () => {
    const { db, incidents } = makeStore([
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
    ]);
    await reconcileSameOwnerCoverageIncident(
      {
        bookingId: "b-main",
        cause: "OFFICER_OVERRIDE",
        actorMemberId: "officer-1",
        reason: "Member asked us to cancel the other booking",
      },
      db,
    );
    expect(incidents[0]).toMatchObject({
      cause: "OFFICER_OVERRIDE",
      overriddenByMemberId: "officer-1",
      overrideReason: "Member asked us to cancel the other booking",
    });
  });

  it("does not refuse from inside the drain, however the club is configured", async () => {
    // `reconcileSameOwnerCoverageIncident` runs post-commit against a booking that
    // is ALREADY confirmed, so there is nothing left to refuse; throwing here would
    // abort the sweep and roll back the incident it exists to record.
    const { db } = makeStore([
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
    ]);
    await expect(
      reconcileSameOwnerCoverageIncident(
        { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
        db,
      ),
    ).resolves.toMatchObject({ action: "opened" });
  });
});
