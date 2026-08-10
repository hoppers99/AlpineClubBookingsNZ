import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/admin/payments/manual-refund-tasks — the finance queue's loader.
 *
 * #2750 gave it a second list. `tasks` is unchanged: OPEN hand-back rows an
 * operator has to settle. `autoRefunded` is the record of a refund nobody
 * authorised — a modification payment captured against a booking the club had
 * already deleted, which the #1350 webhook refunded automatically and whose
 * `ManualRefundTask` the webhook then closed itself. Closing it took it off this
 * route's only list, so the money movement had no screen at all; this is the
 * screen, and this suite is what stops the two lists blurring into each other.
 *
 * Mock shape follows the house route-test precedent
 * (src/app/api/admin/member-guest-settings/__tests__/route.test.ts): the guard
 * and the delegate are stubbed, and the route's real mapping runs.
 *
 * MUTATION PROOF. Drop the shared filter from the second query and "asks the
 * database for exactly the rows the shared filter defines" fails. Drop the
 * `completedAt` window and "bounds the record to a review window" fails. Return
 * the second list under the first list's key, or map `note` away, and the two
 * mapping tests fail. Refuse the route to finance:view and "a finance viewer may
 * read both lists" fails.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  manualRefundTaskFindMany: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: { findMany: mocks.manualRefundTaskFindMany },
  },
}));

import { GET } from "../route";
import {
  AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX,
  AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS,
  automaticCancelledBookingRefundNote,
  automaticallyRefundedManualRefundTaskFilter,
  deletedBookingModificationRefundReason,
} from "@/lib/deleted-booking-modification-payment";

const CHECK_IN = new Date("2026-08-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-12T00:00:00.000Z");
const REFUNDED_AT = new Date("2026-06-28T09:00:00.000Z");

const OPEN_ROW = {
  id: "task-open",
  bookingId: "booking-cash",
  amountCents: 8000,
  reason: "Cancelled after a cash payment",
  createdAt: new Date("2026-06-20T00:00:00.000Z"),
  booking: {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    member: { firstName: "Ada", lastName: "Lovelace" },
  },
};

const AUTO_ROW = {
  id: "task-auto",
  bookingId: "booking-deleted",
  amountCents: 2500,
  reason: deletedBookingModificationRefundReason("pi_modification"),
  note: automaticCancelledBookingRefundNote("pi_modification"),
  completedAt: REFUNDED_AT,
  booking: {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    member: { firstName: "Grace", lastName: "Hopper" },
  },
};

/** The route's two `findMany` calls, in the order it issues them. */
function calls() {
  return mocks.manualRefundTaskFindMany.mock.calls.map(
    (call) => call[0] as Record<string, unknown>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.manualRefundTaskFindMany
    .mockResolvedValueOnce([OPEN_ROW])
    .mockResolvedValueOnce([AUTO_ROW]);
});

describe("GET manual-refund-tasks (#2262, #2750)", () => {
  it("a finance viewer may read both lists — neither is a write", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("refuses with the guard's own response when the actor may not see finance", async () => {
    mocks.requireAdmin.mockReset().mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.manualRefundTaskFindMany).not.toHaveBeenCalled();
  });

  it("keeps the hand-back queue exactly as it was: OPEN, oldest first", async () => {
    await GET();

    expect(calls()[0]).toMatchObject({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("asks the database for exactly the rows the shared filter defines", async () => {
    // Not a restatement of the conditions: the route must use the exported
    // filter, so a change to what counts as an automatic refund reaches this
    // screen without anybody remembering to edit it here.
    await GET();

    expect(calls()[1].where).toMatchObject(
      automaticallyRefundedManualRefundTaskFilter as Record<string, unknown>,
    );
    expect(
      (calls()[1].where as { note: { startsWith: string } }).note.startsWith,
    ).toBe(AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX);
  });

  it("bounds the record to a review window, newest first", async () => {
    // Newest first, and it is the opposite of the queue above on purpose: the
    // queue is worked from the top, whereas the most recent automatic refund is
    // the one an operator can still act on if the deletion was the mistake.
    await GET();

    const second = calls()[1];
    expect(second.orderBy).toEqual({ completedAt: "desc" });
    const window = (second.where as { completedAt: { gte: Date } }).completedAt;
    const days = Math.round(
      (Date.now() - window.gte.getTime()) / (24 * 60 * 60 * 1000),
    );
    expect(days).toBe(AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS);
  });

  it("returns the automatic refunds under their own key, never mixed into the queue", async () => {
    // One list says "you owe this member money" and the other says "this money
    // has already gone back". Merging them is how somebody refunds twice.
    const body = (await (await GET()).json()) as {
      tasks: { id: string }[];
      autoRefunded: { id: string }[];
    };

    expect(body.tasks.map((task) => task.id)).toEqual(["task-open"]);
    expect(body.autoRefunded.map((task) => task.id)).toEqual(["task-auto"]);
  });

  it("carries the reason AND the note, because the reason alone still asks for a decision", async () => {
    const body = (await (await GET()).json()) as {
      autoRefunded: {
        bookingId: string;
        amountCents: number;
        reason: string;
        note: string | null;
        refundedAt: string | null;
        memberName: string;
        checkIn: string;
        checkOut: string;
      }[];
    };

    expect(body.autoRefunded[0]).toEqual({
      id: "task-auto",
      bookingId: "booking-deleted",
      amountCents: 2500,
      reason: deletedBookingModificationRefundReason("pi_modification"),
      note: automaticCancelledBookingRefundNote("pi_modification"),
      refundedAt: REFUNDED_AT.toISOString(),
      memberName: "Grace Hopper",
      checkIn: CHECK_IN.toISOString(),
      checkOut: CHECK_OUT.toISOString(),
    });
  });

  it("answers a missing refund date as null rather than inventing one", async () => {
    // `completedAt` is nullable in the schema and never null on a row the filter
    // matched, since the close writes both in one update. If that ever stops
    // being true the card must render a row whose date it cannot state, not a
    // date it made up.
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...AUTO_ROW, completedAt: null }]);

    const body = (await (await GET()).json()) as {
      autoRefunded: { refundedAt: string | null }[];
    };

    expect(body.autoRefunded[0].refundedAt).toBeNull();
  });

  it("returns two empty lists rather than failing when there is nothing to show", async () => {
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const body = (await (await GET()).json()) as {
      tasks: unknown[];
      autoRefunded: unknown[];
    };

    expect(body).toEqual({ tasks: [], autoRefunded: [] });
  });
});
