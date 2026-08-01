import { AdminReviewStatus, AgeTier } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  evaluateProposedAdultMemberHosting,
  reconcileAdultMemberHostingReview,
  recordAdultMemberHostingReviewForNewBooking,
  parseStoredHostingReview,
  toHostingParticipants,
} from "@/lib/adult-member-hosting-review";
import {
  bookingReviewReasonCodes,
  bookingReviewReasonSentences,
} from "@/lib/booking-review";

const CLUB_ON = {
  id: "policy-club",
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "ADMIN_REVIEW_REQUIRED",
  capacityMode: "NO_HOLD",
  version: 3,
};

const CLUB_OFF = { ...CLUB_ON, mode: "DISABLED" };

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    ageTier: AgeTier.ADULT,
    active: true,
    cancelledAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function guest(
  id: string,
  nights: string[],
  memberRow: ReturnType<typeof member> | null = null,
) {
  return {
    id,
    firstName: id,
    lastName: "Person",
    stayStart: new Date(`${nights[0]}T00:00:00.000Z`),
    stayEnd: new Date(`${nights[nights.length - 1]}T00:00:00.000Z`),
    nights: nights.map((night) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) })),
    member: memberRow,
  };
}

type BookingRow = Record<string, unknown>;

function makeDb(booking: BookingRow | null, policies: unknown[], siblings: BookingRow[] = []) {
  const update = vi.fn().mockResolvedValue({});
  return {
    update,
    db: {
      booking: {
        findUnique: vi.fn().mockResolvedValue(booking),
        findMany: vi.fn().mockResolvedValue(siblings),
        update,
      },
      adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue(policies) },
      lodge: { findFirst: vi.fn() },
      member: { findMany: vi.fn().mockResolvedValue([]) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

function bookingRow(overrides: BookingRow = {}): BookingRow {
  return {
    id: "booking-1",
    memberId: "owner-1",
    parentBookingId: null,
    lodgeId: "lodge-1",
    checkIn: new Date("2026-07-04T00:00:00.000Z"),
    checkOut: new Date("2026-07-06T00:00:00.000Z"),
    adultMemberHostingReview: null,
    adultMemberHostingReviewStatus: null,
    guests: [guest("g1", ["2026-07-04", "2026-07-05"])],
    ...overrides,
  };
}

describe("hosting review reconciliation (#2364)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes nothing when the policy is off and nothing is recorded", async () => {
    const { db, update } = makeDb(bookingRow(), [CLUB_OFF]);
    await expect(
      reconcileAdultMemberHostingReview("booking-1", db),
    ).resolves.toMatchObject({ action: "none" });
    expect(update).not.toHaveBeenCalled();
  });

  it("writes nothing for a booking that does not exist", async () => {
    const { db, update } = makeDb(null, [CLUB_ON]);
    await expect(
      reconcileAdultMemberHostingReview("missing", db),
    ).resolves.toMatchObject({ action: "none" });
    expect(update).not.toHaveBeenCalled();
  });

  it("opens a PENDING review with the frozen snapshot when the rule trips", async () => {
    const { db, update } = makeDb(bookingRow(), [CLUB_ON]);
    const outcome = await reconcileAdultMemberHostingReview("booking-1", db);
    expect(outcome.action).toBe("opened");
    const data = update.mock.calls[0][0].data;
    expect(data.adultMemberHostingReviewStatus).toBe(AdminReviewStatus.PENDING);
    expect(data.adultMemberHostingReviewReason).toBeNull();
    expect(data.adultMemberHostingReviewedById).toBeNull();
    expect(data.adultMemberHostingReview.affectedNights).toEqual([
      "2026-07-04",
      "2026-07-05",
    ]);
    expect(data.adultMemberHostingReview.policyId).toBe("policy-club");
    expect(data.adultMemberHostingReview.policyVersion).toBe(3);
  });

  it("does not trip when an adult member guest covers every night", async () => {
    const { db, update } = makeDb(
      bookingRow({
        guests: [
          guest("g1", ["2026-07-04", "2026-07-05"]),
          guest("m1", ["2026-07-04", "2026-07-05"], member()),
        ],
      }),
      [CLUB_ON],
    );
    await expect(
      reconcileAdultMemberHostingReview("booking-1", db),
    ).resolves.toMatchObject({ action: "none" });
    expect(update).not.toHaveBeenCalled();
  });

  it("clears a pending review the moment the nights become covered", async () => {
    const stored = {
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      policyId: "policy-club",
      policyVersion: 3,
      requirements: { uncovered: [{ guestRef: "g1", night: "2026-07-04" }] },
    };
    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: stored,
        adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
        guests: [
          guest("g1", ["2026-07-04"]),
          guest("m1", ["2026-07-04"], member()),
        ],
      }),
      [CLUB_ON],
    );
    const outcome = await reconcileAdultMemberHostingReview("booking-1", db);
    expect(outcome.action).toBe("cleared");
    const data = update.mock.calls[0][0].data;
    expect(data.adultMemberHostingReviewStatus).toBeNull();
    expect(data.adultMemberHostingReviewedAt).toBeNull();
  });

  it("clears when the club switches the policy off, not only when guests change", async () => {
    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: {
          reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
          policyId: "policy-club",
          policyVersion: 3,
          requirements: { uncovered: [{ guestRef: "g1", night: "2026-07-04" }] },
        },
        adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
      }),
      [CLUB_OFF],
    );
    await expect(
      reconcileAdultMemberHostingReview("booking-1", db),
    ).resolves.toMatchObject({ action: "cleared" });
    expect(update).toHaveBeenCalled();
  });

  it("leaves a decided review alone while the same hazard stands", async () => {
    // Round-trip the real snapshot so the comparison sees identical evidence.
    const first = makeDb(bookingRow(), [CLUB_ON]);
    await reconcileAdultMemberHostingReview("booking-1", first.db);
    const stored = first.update.mock.calls[0][0].data.adultMemberHostingReview;

    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: stored,
        adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
      }),
      [CLUB_ON],
    );
    await expect(
      reconcileAdultMemberHostingReview("booking-1", db),
    ).resolves.toMatchObject({ action: "unchanged" });
    expect(update).not.toHaveBeenCalled();
  });

  it("reopens an approved review when a materially different hazard appears", async () => {
    const first = makeDb(bookingRow(), [CLUB_ON]);
    await reconcileAdultMemberHostingReview("booking-1", first.db);
    const stored = first.update.mock.calls[0][0].data.adultMemberHostingReview;

    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: stored,
        adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
        adultMemberHostingReviewReason: "Long-standing family friend",
        adultMemberHostingReviewedById: "admin-1",
        // A second uncovered guest joins the same nights.
        guests: [
          guest("g1", ["2026-07-04", "2026-07-05"]),
          guest("g2", ["2026-07-04", "2026-07-05"]),
        ],
      }),
      [CLUB_ON],
    );
    const outcome = await reconcileAdultMemberHostingReview("booking-1", db);
    expect(outcome.action).toBe("reopened");
    const data = update.mock.calls[0][0].data;
    expect(data.adultMemberHostingReviewStatus).toBe(AdminReviewStatus.PENDING);
    // The previous decision does not survive a different question.
    expect(data.adultMemberHostingReviewReason).toBeNull();
    expect(data.adultMemberHostingReviewedById).toBeNull();
  });

  it("adopts an unsnapshotted flagged booking without reopening its decision", async () => {
    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: null,
        adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
      }),
      [CLUB_ON],
    );
    const outcome = await reconcileAdultMemberHostingReview("booking-1", db);
    // A status with no snapshot counts as RECORDED, so this is a reopen path,
    // not a first open: there is nothing to compare against, so the safe answer
    // is a fresh decision rather than silently inheriting the old one.
    expect(outcome.action).toBe("reopened");
    expect(update.mock.calls[0][0].data.adultMemberHostingReviewStatus).toBe(
      AdminReviewStatus.PENDING,
    );
  });

  it("borrows the split parent's adults so a #738 non-member child is not always in breach", async () => {
    const child = bookingRow({
      id: "child-1",
      parentBookingId: "parent-1",
      guests: [guest("g1", ["2026-07-04"])],
    });
    const parent = bookingRow({
      id: "parent-1",
      parentBookingId: null,
      guests: [guest("m1", ["2026-07-04"], member())],
    });
    const { db, update } = makeDb(child, [CLUB_ON], [parent]);
    await expect(
      reconcileAdultMemberHostingReview("child-1", db),
    ).resolves.toMatchObject({ action: "none" });
    expect(update).not.toHaveBeenCalled();
    // Only same-member, live siblings are considered.
    const where = db.booking.findMany.mock.calls[0][0].where;
    expect(where.memberId).toBe("owner-1");
    expect(where.deletedAt).toBeNull();
    expect(where.status).toEqual({ notIn: ["CANCELLED", "BUMPED"] });
  });

  it("does not borrow anybody when the policy is off — the sibling read is skipped", async () => {
    const { db } = makeDb(bookingRow(), [CLUB_OFF]);
    await reconcileAdultMemberHostingReview("booking-1", db);
    expect(db.booking.findMany).not.toHaveBeenCalled();
  });

  it("records an admin on-behalf decision, and refuses to approve without one", async () => {
    const approved = makeDb(bookingRow(), [CLUB_ON]);
    await recordAdultMemberHostingReviewForNewBooking("booking-1", approved.db, {
      reason: "Long-standing family friend of the club",
      byMemberId: "admin-9",
    });
    const data = approved.update.mock.calls[0][0].data;
    expect(data.adultMemberHostingReviewStatus).toBe(AdminReviewStatus.APPROVED);
    expect(data.adultMemberHostingReviewReason).toBe(
      "Long-standing family friend of the club",
    );
    expect(data.adultMemberHostingReviewedById).toBe("admin-9");
    expect(data.adultMemberHostingReviewedAt).toBeInstanceOf(Date);

    const pending = makeDb(bookingRow(), [CLUB_ON]);
    await recordAdultMemberHostingReviewForNewBooking("booking-1", pending.db, null);
    expect(
      pending.update.mock.calls[0][0].data.adultMemberHostingReviewStatus,
    ).toBe(AdminReviewStatus.PENDING);

    // Belt and braces: an APPROVED open with no reason is a programming error
    // and fails loudly rather than waving the booking through.
    const bad = makeDb(bookingRow(), [CLUB_ON]);
    await expect(
      reconcileAdultMemberHostingReview("booking-1", bad.db, {
        openedStatus: AdminReviewStatus.APPROVED,
      }),
    ).rejects.toThrow(/explicit decision reason/i);
    expect(bad.update).not.toHaveBeenCalled();
  });
});

describe("participant construction (#2364)", () => {
  it("uses the sparse per-night rows when they exist", () => {
    const participants = toHostingParticipants({
      guests: [guest("g1", ["2026-07-04", "2026-07-06"])],
    });
    expect(participants[0].nights).toEqual(["2026-07-04", "2026-07-06"]);
  });

  it("falls back to the GUEST's own envelope for pre-#713 rows, never the booking's", () => {
    const participants = toHostingParticipants({
      guests: [
        {
          id: "legacy",
          firstName: "Legacy",
          lastName: "Row",
          stayStart: new Date("2026-07-04T00:00:00.000Z"),
          stayEnd: new Date("2026-07-06T00:00:00.000Z"),
          nights: [],
          member: null,
        },
      ],
    });
    // stayEnd is exclusive: two nights, not three.
    expect(participants[0].nights).toEqual(["2026-07-04", "2026-07-05"]);
  });
});

describe("stored snapshot parsing (#2364)", () => {
  it("refuses anything that is not a hosting snapshot with comparable evidence", () => {
    expect(parseStoredHostingReview(null)).toBeNull();
    expect(parseStoredHostingReview("nope")).toBeNull();
    expect(parseStoredHostingReview([])).toBeNull();
    expect(parseStoredHostingReview({ reasonCode: "MINIMUM_STAY" })).toBeNull();
    expect(
      parseStoredHostingReview({
        reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
        policyId: "p",
        policyVersion: 1,
        requirements: {},
      }),
    ).toBeNull();
  });
});

describe("structured review reason codes (#2364)", () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    [
      "no review at all",
      { requiresAdminReview: false, adminReviewStatus: null, adultMemberHostingReviewStatus: null },
      [],
    ],
    [
      "the minors rule alone",
      {
        requiresAdminReview: true,
        adminReviewStatus: AdminReviewStatus.PENDING,
        adultMemberHostingReviewStatus: null,
      },
      ["ADULT_SUPERVISION"],
    ],
    [
      "the hosting policy alone",
      {
        requiresAdminReview: false,
        adminReviewStatus: null,
        adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
      },
      ["ADULT_MEMBER_HOSTING_REQUIRED"],
    ],
    [
      "both at once, in a fixed order",
      {
        requiresAdminReview: true,
        adminReviewStatus: AdminReviewStatus.PENDING,
        adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
      },
      ["ADULT_SUPERVISION", "ADULT_MEMBER_HOSTING_REQUIRED"],
    ],
  ];

  for (const [label, booking, expected] of cases) {
    it(`reports ${label}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const codes = bookingReviewReasonCodes(booking as any);
      expect(codes).toEqual(expected);
      expect(bookingReviewReasonSentences(codes)).toHaveLength(expected.length);
    });
  }

  it("gives each code its own sentence, so neither hazard is described by the other", () => {
    const sentences = bookingReviewReasonSentences([
      "ADULT_SUPERVISION",
      "ADULT_MEMBER_HOSTING_REQUIRED",
    ]);
    expect(sentences[0]).toMatch(/does not include an adult guest/);
    expect(sentences[1]).toMatch(/no adult member is staying/);
    expect(sentences[0]).not.toBe(sentences[1]);
  });
});

describe("pre-persist evaluation for the create path (#2364)", () => {
  const db = (policies: unknown[], members: unknown[] = []) =>
    ({
      adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue(policies) },
      member: { findMany: vi.fn().mockResolvedValue(members) },
      lodge: { findFirst: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  const input = {
    lodgeId: "lodge-1",
    checkIn: new Date("2026-07-04T00:00:00.000Z"),
    checkOut: new Date("2026-07-06T00:00:00.000Z"),
    guests: [{ firstName: "Non", lastName: "Member" }],
  };

  it("returns nothing while the policy is off, without reading members", async () => {
    const client = db([CLUB_OFF]);
    await expect(
      evaluateProposedAdultMemberHosting(client, input),
    ).resolves.toBeNull();
    expect(client.member.findMany).not.toHaveBeenCalled();
  });

  it("trips on a submitted party with no adult member on the nights", async () => {
    const violation = await evaluateProposedAdultMemberHosting(db([CLUB_ON]), input);
    expect(violation).not.toBeNull();
    expect(violation!.affectedNights).toEqual(["2026-07-04", "2026-07-05"]);
    // Pre-persist refs are positional; the stored snapshot always comes from
    // the reconciler and carries real BookingGuest ids.
    expect(violation!.requirements.uncovered[0].guestRef).toBe("guest:0");
  });

  it("clears once an adult member is on the same nights", async () => {
    const violation = await evaluateProposedAdultMemberHosting(
      db([CLUB_ON], [member({ id: "m-1" })]),
      {
        ...input,
        guests: [
          { firstName: "Non", lastName: "Member" },
          { firstName: "Ada", lastName: "Member", memberId: "m-1" },
        ],
      },
    );
    expect(violation).toBeNull();
  });

  it("never credits a member whose live row says they cannot host", async () => {
    for (const bad of [
      { ageTier: AgeTier.YOUTH },
      { active: false },
      { cancelledAt: new Date("2026-01-01") },
      { archivedAt: new Date("2026-01-01") },
    ]) {
      const violation = await evaluateProposedAdultMemberHosting(
        db([CLUB_ON], [member({ id: "m-1", ...bad })]),
        {
          ...input,
          guests: [
            { firstName: "Non", lastName: "Member" },
            { firstName: "Ada", lastName: "Member", memberId: "m-1" },
          ],
        },
      );
      expect(violation).not.toBeNull();
    }
  });

  it("uses each guest's own submitted nights, so a partial stay is judged per night", async () => {
    const violation = await evaluateProposedAdultMemberHosting(
      db([CLUB_ON], [member({ id: "m-1" })]),
      {
        ...input,
        guests: [
          { firstName: "Non", lastName: "Member", nights: ["2026-07-04", "2026-07-05"] },
          { firstName: "Ada", lastName: "Member", memberId: "m-1", nights: ["2026-07-04"] },
        ],
      },
    );
    expect(violation!.affectedNights).toEqual(["2026-07-05"]);
  });
});
