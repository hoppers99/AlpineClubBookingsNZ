import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2750 — the record is only "a human is told" if a human can see it.
 *
 * THE DECISION, AND WHY THERE IS NO GATE HERE. Since #1350 the Stripe webhook
 * refunds a modification payment captured against an already-CANCELLED booking
 * automatically, and a soft-deleted booking is always CANCELLED
 * (`INV-ADDPAY-030`), so a late capture on a deleted booking is refunded before
 * anybody sees it. #2750 kept that deliberately: the member's money going back
 * is the safe direction when nobody is watching, and gating it leaves the club
 * holding a member's money until somebody acts. What #2750 changed is that the
 * `ManualRefundTask` the webhook closes behind itself now reaches an operator —
 * `/admin/payments` lists rows matching
 * `automaticallyRefundedManualRefundTaskFilter` as a read-only card.
 *
 * NO MONEY BEHAVIOUR CHANGED, and the round trip at the bottom pins that from
 * the money side: still exactly one task per capture, still closed exactly once,
 * replays included.
 *
 * WHAT THE CARD DOES NOT SHOW is pinned here too, because the surface is a
 * partial record by construction: only the ordering where the confirm endpoint
 * raised a task first ever produces a row. See "what the card cannot show" below,
 * and the qualification in `INV-ADDPAY-037`.
 *
 * MUTATION PROOF. Reword the note prefix and "pins the stored bytes of the note
 * prefix" fails — that one assertion is a golden string precisely because every
 * other one derives its expectation from the constant and so cannot catch a
 * reword. Reword the close's note without moving the shared constant and
 * "the note the close writes is the note the surface matches on" fails. Drop
 * `completedByMemberId: null` from the filter and "an operator's own dismissal is
 * never presented as an automatic refund" fails on its first row; drop the note
 * condition and the same test fails on its second, which is the row the schema's
 * `onDelete: SetNull` produces. Widen the filter to any DISMISSED row and "an
 * OPEN task is work, not a notice" fails. Break the raise's idempotence or the
 * close's OPEN fence and "raises and closes exactly one task per capture" fails.
 */

const mocks = vi.hoisted(() => ({
  manualRefundTaskFindFirst: vi.fn(),
  manualRefundTaskCreate: vi.fn(),
  manualRefundTaskUpdateMany: vi.fn(),
  paymentTransactionFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: {
      updateMany: (...args: unknown[]) =>
        mocks.manualRefundTaskUpdateMany(...args),
    },
    $transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
}));

import {
  AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX,
  AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS,
  automaticCancelledBookingRefundNote,
  automaticallyRefundedManualRefundTaskFilter,
  closeDeletedBookingModificationRefundTaskAfterAutomaticRefund,
  raiseDeletedBookingModificationRefundTask,
} from "@/lib/deleted-booking-modification-payment";

const BOOKING_ID = "booking-1";
const PAYMENT_ID = "payment-1";
const INTENT_ID = "pi_modification";
const AMOUNT_CENTS = 2500;

interface StoredTask {
  id: string;
  bookingId: string;
  paymentId: string;
  reason: string;
  status: string;
  note: string | null;
  completedByMemberId: string | null;
}

const tx = {
  $executeRaw: mocks.executeRaw,
  manualRefundTask: {
    findFirst: (...args: unknown[]) => mocks.manualRefundTaskFindFirst(...args),
    create: (...args: unknown[]) => mocks.manualRefundTaskCreate(...args),
  },
  paymentTransaction: {
    findUnique: (...args: unknown[]) =>
      mocks.paymentTransactionFindUnique(...args),
  },
};

function raise() {
  return raiseDeletedBookingModificationRefundTask({
    bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID,
    paymentIntentId: INTENT_ID,
    amountCents: AMOUNT_CENTS,
  });
}

function close() {
  return closeDeletedBookingModificationRefundTaskAfterAutomaticRefund({
    bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID,
    paymentIntentId: INTENT_ID,
  });
}

/**
 * Applies the exported filter's own conditions to a candidate row.
 *
 * A unit test has no database, so the alternative is asserting only the filter's
 * shape — which cannot catch a filter whose shape is fine and whose semantics
 * still admit an operator's own dismissal. This reads each condition off the
 * exported object rather than restating it, so it goes wrong exactly when the
 * filter goes wrong.
 */
function matchesFilter(row: {
  status: string;
  completedByMemberId: string | null;
  note: string | null;
}): boolean {
  const filter = automaticallyRefundedManualRefundTaskFilter as {
    status: string;
    completedByMemberId: null;
    note: { startsWith: string };
  };
  return (
    row.status === filter.status &&
    row.completedByMemberId === filter.completedByMemberId &&
    (row.note ?? "").startsWith(filter.note.startsWith)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeRaw.mockResolvedValue(1);
  mocks.transaction.mockImplementation(
    async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  );
  mocks.manualRefundTaskFindFirst.mockResolvedValue(null);
  mocks.manualRefundTaskCreate.mockResolvedValue({ id: "task-1" });
  mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentTransactionFindUnique.mockResolvedValue({
    status: "SUCCEEDED",
    refundedAmountCents: 0,
    amountCents: AMOUNT_CENTS,
  });
});

describe("the note the close writes and the surface reads (#2750)", () => {
  it("pins the stored bytes of the note prefix, which are data and not copy", () => {
    /*
      A GOLDEN STRING, deliberately, and the one assertion in this file that does
      NOT derive its expectation from the constant.

      Every other assertion here reads the expected value off
      `AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX`, which is right for proving
      writer and reader agree — and is a tautology with respect to the value
      itself. Rewording the constant would keep all of them green while making
      every note ALREADY IN THE DATABASE stop matching `startsWith`, silently
      emptying the card of every automatic refund the club has had so far. That is
      the exact defect #2750 exists to close, arriving through the back door.

      So these bytes are stored data, not display copy. Changing them needs a
      migration that rewrites the existing notes (or a reader that matches both
      the old and the new prefix), not an edit here. Reworded on purpose? Then
      update this string in the same commit as that migration and say so.
    */
    expect(AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX).toBe(
      "Closed automatically: Stripe refunded this capture under the cancelled-booking late-capture path",
    );
  });

  it("the note the close writes is the note the surface matches on", async () => {
    // Two copies of one sentence would not fail a build. It would silently empty
    // the card, which is the entire mechanism by which anybody is told.
    await close();

    const call = mocks.manualRefundTaskUpdateMany.mock.calls[0][0] as {
      data: { note: string };
    };
    expect(call.data.note).toBe(automaticCancelledBookingRefundNote(INTENT_ID));
    expect(
      call.data.note.startsWith(AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX),
    ).toBe(true);
    expect(automaticallyRefundedManualRefundTaskFilter.note).toEqual({
      startsWith: AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX,
    });
  });

  it("still fits the 500-char column for an implausibly long payment intent id", () => {
    const note = automaticCancelledBookingRefundNote("pi_".padEnd(600, "x"));

    expect(note.length).toBeLessThanOrEqual(500);
  });

  it("leaves no acting member, which is what the card claims on screen", async () => {
    await close();

    const call = mocks.manualRefundTaskUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // The close never writes `completedByMemberId`, so the column keeps its NULL.
    expect(call.data.completedByMemberId).toBeUndefined();
    expect(automaticallyRefundedManualRefundTaskFilter).toMatchObject({
      status: "DISMISSED",
      completedByMemberId: null,
    });
  });

  it("bounds the card's reach to a review window rather than all history", () => {
    // Unbounded is the state that makes an operator stop reading the card.
    expect(AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS).toBeGreaterThan(0);
    expect(AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS).toBeLessThanOrEqual(90);
  });
});

describe("which rows the operator surface shows (#2750)", () => {
  it("shows the row the webhook closed", () => {
    expect(
      matchesFilter({
        status: "DISMISSED",
        completedByMemberId: null,
        note: automaticCancelledBookingRefundNote(INTENT_ID),
      }),
    ).toBe(true);
  });

  it("an operator's own dismissal is never presented as an automatic refund", () => {
    // Two rows, failing on different halves of the filter. The first is an
    // ordinary hand dismissal. The second is that same dismissal after the
    // member who made it was deleted: `ManualRefundTask.completedBy` is
    // `onDelete: SetNull`, so the column that said who did it now says nobody
    // did — and on the note condition alone being dropped, the club's own
    // deliberate dismissal would be shown as a refund it never made.
    expect(
      matchesFilter({
        status: "DISMISSED",
        completedByMemberId: "member-1",
        note: "Member asked us to keep it as a donation",
      }),
    ).toBe(false);
    expect(
      matchesFilter({
        status: "DISMISSED",
        completedByMemberId: null,
        note: "Member asked us to keep it as a donation",
      }),
    ).toBe(false);
  });

  it("an OPEN task is work, not a notice", () => {
    // It belongs in the hand-back queue above, where it has buttons.
    expect(
      matchesFilter({ status: "OPEN", completedByMemberId: null, note: null }),
    ).toBe(false);
  });

  it("a COMPLETED task is money an operator handed back by hand", () => {
    expect(
      matchesFilter({
        status: "COMPLETED",
        completedByMemberId: "member-1",
        note: "Cash handed back at the lodge",
      }),
    ).toBe(false);
  });
});

describe("what the card cannot show, and why the claim is qualified (#2750 review)", () => {
  /*
    THE CARD IS A PARTIAL RECORD BY CONSTRUCTION, and this is where that is
    stated in code rather than only in a document.

    A row reaches the card only when the confirm endpoint raised a
    `ManualRefundTask` first, because that endpoint is the ONLY writer of one on
    this path. Two real orderings therefore produce an automatic refund with no
    row at all: the webhook arriving first (which includes the member who simply
    closes the tab after paying, so the confirm endpoint is never called), and the
    webhook completing inside the confirm route's own Stripe round trip. Neither
    is exotic — webhook-first is the healthy case.

    These tests exist so that a future agent who reads `INV-ADDPAY-037` as "every
    automatic refund appears on the finance queue" is corrected by the suite. If
    somebody makes the record complete — the follow-up option is for the webhook
    to write the DISMISSED row itself when its fenced close claims nothing — these
    are the tests that must be changed on purpose, and the invariant's
    qualification lifted in the same commit.
  */
  it("a close that claims no row creates nothing, so a webhook-first refund reaches no card", async () => {
    // The healthy ordering: the webhook refunds and closes before any task
    // exists, so its OPEN-fenced `updateMany` claims nothing. It must not invent
    // a row (that is the follow-up decision, not this change), and the absence is
    // what makes the card's coverage partial.
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    expect(await close()).toBe(0);
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
  });

  it("the interleaved ordering is fenced off with no row, on purpose", async () => {
    // Stripe refunded the capture inside the confirm route's own round trip. The
    // raise refuses rather than queueing an operator to hand back money that has
    // already gone — so again there is a real automatic refund and no row.
    mocks.paymentTransactionFindUnique.mockResolvedValue({
      status: "REFUNDED",
      refundedAmountCents: AMOUNT_CENTS,
      amountCents: AMOUNT_CENTS,
    });

    const result = await raise();

    expect(result).toEqual({
      taskId: null,
      created: false,
      alreadyRefunded: true,
    });
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
  });
});

describe("one task per capture, closed once (#2750 acceptance)", () => {
  it("raises and closes exactly one task per capture, replays included", async () => {
    /*
      The acceptance criterion as a round trip over one in-memory row, rather
      than as two separate assertions about mock arguments. Sequence: the confirm
      route raises, the webhook closes, Stripe redelivers so the webhook closes
      again, and the confirm route is retried so the raise runs again. One row,
      one close, and no money decision left behind.
    */
    const rows: StoredTask[] = [];
    let nextId = 1;

    mocks.manualRefundTaskFindFirst.mockImplementation(
      async (args: {
        where: { bookingId: string; paymentId: string; reason: string };
      }) =>
        rows.find(
          (row) =>
            row.bookingId === args.where.bookingId &&
            row.paymentId === args.where.paymentId &&
            row.reason === args.where.reason,
        ) ?? null,
    );
    mocks.manualRefundTaskCreate.mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        const row: StoredTask = {
          id: `task-${nextId++}`,
          bookingId: args.data.bookingId as string,
          paymentId: args.data.paymentId as string,
          reason: args.data.reason as string,
          status: args.data.status as string,
          note: null,
          completedByMemberId: null,
        };
        rows.push(row);
        return { id: row.id };
      },
    );
    mocks.manualRefundTaskUpdateMany.mockImplementation(
      async (args: {
        where: {
          bookingId: string;
          paymentId: string;
          reason: string;
          status: string;
        };
        data: { status: string; note: string };
      }) => {
        const claimed = rows.filter(
          (row) =>
            row.bookingId === args.where.bookingId &&
            row.paymentId === args.where.paymentId &&
            row.reason === args.where.reason &&
            row.status === args.where.status,
        );
        for (const row of claimed) {
          row.status = args.data.status;
          row.note = args.data.note;
        }
        return { count: claimed.length };
      },
    );

    const first = await raise();
    expect(first.created).toBe(true);
    expect(rows).toHaveLength(1);

    expect(await close()).toBe(1);
    // Stripe redelivers. The OPEN fence means the second close claims nothing,
    // so the row is not re-dated and the card does not gain a duplicate.
    expect(await close()).toBe(0);

    // The retried confirm finds the row it already raised — matched across EVERY
    // status, so a closed one still counts — and raises nothing.
    const retry = await raise();
    expect(retry.created).toBe(false);
    expect(retry.taskId).toBe(first.taskId);
    expect(rows).toHaveLength(1);
    expect(mocks.manualRefundTaskCreate).toHaveBeenCalledTimes(1);

    // And that single row is exactly what the operator surface shows.
    expect(matchesFilter(rows[0])).toBe(true);
  });
});
