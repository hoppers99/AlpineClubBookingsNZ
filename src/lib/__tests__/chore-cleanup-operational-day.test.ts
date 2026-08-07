/**
 * #2622 — chore cleanup reads the SAME operational-day rule as eligibility.
 *
 * Owner decision D-M6: cleanup loads the canonical night set and asks the
 * shared helper, so a row the roster would legitimately create can never be
 * deleted by the cleanup that runs when a booking moves. The checkout-day rows
 * this issue introduces are the case that used to be silently swept away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

type StoredAssignment = {
  id: string;
  date: Date;
  status: "SUGGESTED" | "CONFIRMED" | "COMPLETED";
  bookingId: string;
  bookingGuestId: string | null;
  choreTemplate: { name: string };
  bookingGuest?: {
    stayStart: Date;
    stayEnd: Date;
    nights: Array<{ stayDate: Date }>;
  } | null;
  booking?: { checkIn: Date; checkOut: Date };
};

/** Apply the booking-envelope `OR` predicate the date-change cleanup builds. */
function matchesDatePredicate(where: unknown, row: StoredAssignment): boolean {
  const clauses = (where as { OR: Array<{ date: Record<string, Date> }> }).OR;
  return clauses.some((clause) => {
    const [operator, value] = Object.entries(clause.date)[0];
    if (operator === "lt") return row.date.getTime() < value.getTime();
    if (operator === "lte") return row.date.getTime() <= value.getTime();
    if (operator === "gt") return row.date.getTime() > value.getTime();
    if (operator === "gte") return row.date.getTime() >= value.getTime();
    throw new Error(`unexpected operator ${operator}`);
  });
}

function makeTx(rows: StoredAssignment[], selected: (where: unknown, row: StoredAssignment) => boolean) {
  const deleted: string[] = [];
  const lockedDates: string[] = [];
  const tx = {
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      lockedDates.push(String(values[0]));
      return 1;
    },
    choreAssignment: {
      findMany: vi.fn(async (args: { where: unknown }) =>
        rows.filter((row) => selected(args.where, row)),
      ),
      deleteMany: vi.fn(async (args: { where: { id: string; status?: string } }) => {
        const target = rows.find((row) => row.id === args.where.id);
        if (!target) return { count: 0 };
        if (args.where.status && target.status !== args.where.status) return { count: 0 };
        deleted.push(target.id);
        return { count: 1 };
      }),
    },
  };
  return { tx: tx as never, deleted, lockedDates };
}

describe("cleanupChoreAssignmentsForDateChange (#2622)", () => {
  beforeEach(() => vi.clearAllMocks());

  const NEW_CHECK_IN = day("2026-07-10");
  const NEW_CHECK_OUT = day("2026-07-13");

  function rows(): StoredAssignment[] {
    return [
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-12",
      "2026-07-13",
      "2026-07-14",
    ].map((iso) => ({
      id: `row-${iso}`,
      date: day(iso),
      status: "SUGGESTED" as const,
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      choreTemplate: { name: "Sweep" },
    }));
  }

  it("MUTATION PROBE: keeps the check-out day and removes only what is outside the operational span", async () => {
    // The operational span is [check-in, check-out] INCLUSIVE. Reverting the
    // predicate to `gte: newCheckOut` deletes row-2026-07-13 — a legitimate
    // departure-morning chore — and fails here.
    const { tx, deleted } = makeTx(rows(), matchesDatePredicate);
    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      "booking-1",
      NEW_CHECK_IN,
      NEW_CHECK_OUT,
    );
    expect(deleted.sort()).toEqual([
      "row-2026-07-08",
      "row-2026-07-09",
      "row-2026-07-14",
    ]);
    expect(deleted).not.toContain("row-2026-07-13");
    expect(result.deletedCount).toBe(3);
  });

  it("builds a strictly-greater-than check-out bound and an unchanged check-in bound", async () => {
    const { tx } = makeTx(rows(), matchesDatePredicate);
    await cleanupChoreAssignmentsForDateChange(tx, "booking-1", NEW_CHECK_IN, NEW_CHECK_OUT);
    const where = (tx as unknown as {
      choreAssignment: { findMany: { mock: { calls: Array<[{ where: unknown }]> } } };
    }).choreAssignment.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      bookingId: "booking-1",
      OR: [{ date: { lt: NEW_CHECK_IN } }, { date: { gt: NEW_CHECK_OUT } }],
    });
  });

  it("warns instead of deleting a CONFIRMED row that falls outside the span", async () => {
    const stored = rows();
    stored[0].status = "CONFIRMED";
    const { tx, deleted } = makeTx(stored, matchesDatePredicate);
    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      "booking-1",
      NEW_CHECK_IN,
      NEW_CHECK_OUT,
    );
    expect(deleted).not.toContain("row-2026-07-08");
    expect(result.choreWarnings).toEqual([
      "Sweep on 2026-07-08 is CONFIRMED and was not auto-removed",
    ]);
  });

  it("takes the roster-date locks before the first delete unless the caller holds them", async () => {
    const { tx, lockedDates } = makeTx(rows(), matchesDatePredicate);
    await cleanupChoreAssignmentsForDateChange(tx, "booking-1", NEW_CHECK_IN, NEW_CHECK_OUT);
    expect(lockedDates).toEqual([
      "roster:2026-07-08",
      "roster:2026-07-09",
      "roster:2026-07-14",
    ]);

    const alreadyLocked = makeTx(rows(), matchesDatePredicate);
    await cleanupChoreAssignmentsForDateChange(
      alreadyLocked.tx,
      "booking-1",
      NEW_CHECK_IN,
      NEW_CHECK_OUT,
      { rosterDatesAlreadyLocked: true },
    );
    expect(alreadyLocked.lockedDates).toEqual([]);
  });
});

describe("cleanupChoreAssignmentsForGuestStayRanges (#2622, D-M6)", () => {
  beforeEach(() => vi.clearAllMocks());

  // Nights 5 and 8 with a real gap between them. Operational presence is
  // {5, 6, 8, 9}: each segment's night plus the morning after it.
  const SPARSE_GUEST = {
    stayStart: day("2026-07-05"),
    stayEnd: day("2026-07-09"),
    nights: [{ stayDate: day("2026-07-05") }, { stayDate: day("2026-07-08") }],
  };
  const BOOKING = { checkIn: day("2026-07-05"), checkOut: day("2026-07-09") };

  function sparseRows(): StoredAssignment[] {
    return ["2026-07-04", "2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10"].map(
      (iso) => ({
        id: `row-${iso}`,
        date: day(iso),
        status: "SUGGESTED" as const,
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        choreTemplate: { name: "Sweep" },
        bookingGuest: SPARSE_GUEST,
        booking: BOOKING,
      }),
    );
  }

  it("MUTATION PROBE: retains EVERY segment's departure morning and deletes the gap strays", async () => {
    // Retained: 5 and 8 (nights), 6 and 9 (departure mornings).
    // Deleted: 4 (before the stay), 7 (the internal gap day, the accepted D-M6
    // side effect), 10 (after the final departure morning).
    const { tx, deleted } = makeTx(sparseRows(), () => true);
    const result = await cleanupChoreAssignmentsForGuestStayRanges(tx, "booking-1");
    expect(deleted.sort()).toEqual([
      "row-2026-07-04",
      "row-2026-07-07",
      "row-2026-07-10",
    ]);
    expect(deleted).not.toContain("row-2026-07-06");
    expect(deleted).not.toContain("row-2026-07-09");
    expect(result.deletedCount).toBe(3);
  });

  it("retains a contiguous guest's checkout-day row", async () => {
    const guest = {
      stayStart: day("2026-07-10"),
      stayEnd: day("2026-07-13"),
      nights: [
        { stayDate: day("2026-07-10") },
        { stayDate: day("2026-07-11") },
        { stayDate: day("2026-07-12") },
      ],
    };
    const stored: StoredAssignment[] = ["2026-07-12", "2026-07-13", "2026-07-14"].map((iso) => ({
      id: `row-${iso}`,
      date: day(iso),
      status: "SUGGESTED" as const,
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      choreTemplate: { name: "Strip beds" },
      bookingGuest: guest,
      booking: { checkIn: day("2026-07-10"), checkOut: day("2026-07-13") },
    }));
    const { tx, deleted } = makeTx(stored, () => true);
    await cleanupChoreAssignmentsForGuestStayRanges(tx, "booking-1");
    expect(deleted).toEqual(["row-2026-07-14"]);
  });

  it("loads the canonical night rows rather than comparing envelopes", async () => {
    const { tx } = makeTx(sparseRows(), () => true);
    await cleanupChoreAssignmentsForGuestStayRanges(tx, "booking-1");
    const call = (tx as unknown as {
      choreAssignment: { findMany: { mock: { calls: Array<[Record<string, unknown>]> } } };
    }).choreAssignment.findMany.mock.calls[1][0];
    expect(call.include).toMatchObject({
      bookingGuest: {
        select: {
          stayStart: true,
          stayEnd: true,
          nights: { select: { stayDate: true } },
        },
      },
      booking: { select: { checkIn: true, checkOut: true } },
    });
  });

  it("warns instead of deleting a COMPLETED row stranded outside the stay", async () => {
    const stored = sparseRows();
    const stray = stored.find((row) => row.id === "row-2026-07-10")!;
    stray.status = "COMPLETED";
    const { tx, deleted } = makeTx(stored, () => true);
    const result = await cleanupChoreAssignmentsForGuestStayRanges(tx, "booking-1");
    expect(deleted).not.toContain("row-2026-07-10");
    expect(result.choreWarnings).toEqual([
      "Sweep on 2026-07-10 is COMPLETED and falls outside the guest's stay range",
    ]);
  });

  it("skips rows with no guest attribution", async () => {
    const stored = sparseRows().map((row) => ({
      ...row,
      bookingGuest: null,
      bookingGuestId: null,
    }));
    const { tx, deleted } = makeTx(stored, () => true);
    const result = await cleanupChoreAssignmentsForGuestStayRanges(tx, "booking-1");
    expect(deleted).toEqual([]);
    expect(result.choreWarnings).toEqual([]);
  });
});
