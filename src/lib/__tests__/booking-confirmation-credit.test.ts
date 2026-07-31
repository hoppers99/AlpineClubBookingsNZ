import { describe, expect, it, vi } from "vitest";

// #2328 — the confirmation email's applied-credit read. The figure it quotes
// has to come from the booking's PERSISTED records, not from re-running the
// credit policy: `calculateBookingCreditApplication` answers "what would we
// apply now", against a balance and a price that have both moved since the
// booking was paid.

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  loadBookingAppliedCredit,
  resolveConfirmationSettlementMethod,
} from "@/lib/booking-confirmation-credit";

type LedgerRow = { amountCents: number };

function fakeDb({
  ledger = [] as LedgerRow[],
  payment = null as {
    source: "STRIPE" | "INTERNET_BANKING";
    manuallyMarkedPaidAt: Date | null;
  } | null,
  paymentMirrorCents,
}: {
  ledger?: LedgerRow[];
  payment?: {
    source: "STRIPE" | "INTERNET_BANKING";
    manuallyMarkedPaidAt: Date | null;
  } | null;
  paymentMirrorCents?: number;
}) {
  return {
    memberCredit: {
      aggregate: vi.fn().mockResolvedValue({
        _sum: {
          amountCents: ledger.length
            ? ledger.reduce((sum, row) => sum + row.amountCents, 0)
            : null,
        },
      }),
    },
    payment: {
      findUnique: vi.fn().mockResolvedValue(
        payment
          ? { ...payment, ...(paymentMirrorCents !== undefined ? { creditAppliedCents: paymentMirrorCents } : {}) }
          : null,
      ),
    },
  };
}

describe("#2328 loadBookingAppliedCredit", () => {
  it("reports the ledger's applied total as positive integer cents", async () => {
    // BOOKING_APPLIED rows are stored NEGATIVE (money leaving the balance).
    const db = fakeDb({
      ledger: [{ amountCents: -12000 }],
      payment: { source: "STRIPE", manuallyMarkedPaidAt: null },
    });

    await expect(
      loadBookingAppliedCredit("bk_1", db as any),
    ).resolves.toEqual({ amountCents: 12000, settlementMethod: "card" });
    expect(db.memberCredit.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appliedToBookingId: "bk_1",
          type: "BOOKING_APPLIED",
        }),
      }),
    );
  });

  it("nets a later reprice clamp offset out of the figure it quotes", async () => {
    // #1887 refunds over-consumed credit as a POSITIVE BOOKING_APPLIED offset
    // row against the same booking, so the sum — not the original debit — is
    // what the member actually spent on this stay.
    const db = fakeDb({
      ledger: [{ amountCents: -12000 }, { amountCents: 4000 }],
      payment: { source: "STRIPE", manuallyMarkedPaidAt: null },
    });

    await expect(loadBookingAppliedCredit("bk_1", db as any)).resolves.toEqual({
      amountCents: 8000,
      settlementMethod: "card",
    });
  });

  it("reads the ledger, never the Payment mirror", async () => {
    // A Payment row whose creditAppliedCents disagrees with the ledger must not
    // change the answer: member-credit.ts documents the ledger sum as the
    // authority every effective-price guard keys on.
    const db = fakeDb({
      ledger: [{ amountCents: -12000 }],
      payment: { source: "STRIPE", manuallyMarkedPaidAt: null },
      paymentMirrorCents: 99999,
    });

    const result = await loadBookingAppliedCredit("bk_1", db as any);
    expect(result.amountCents).toBe(12000);
  });

  it("reports no credit for a booking with no ledger rows at all", async () => {
    const db = fakeDb({ payment: { source: "STRIPE", manuallyMarkedPaidAt: null } });

    await expect(loadBookingAppliedCredit("bk_1", db as any)).resolves.toEqual({
      amountCents: 0,
      settlementMethod: "card",
    });
  });
});

describe("#2328 resolveConfirmationSettlementMethod", () => {
  it("calls a Stripe settlement a card payment", () => {
    expect(
      resolveConfirmationSettlementMethod({
        source: "STRIPE",
        manuallyMarkedPaidAt: null,
      }),
    ).toBe("card");
  });

  it("calls a reconciled Internet Banking settlement a bank transfer", () => {
    expect(
      resolveConfirmationSettlementMethod({
        source: "INTERNET_BANKING",
        manuallyMarkedPaidAt: null,
      }),
    ).toBe("bank_transfer");
  });

  it("keys a manual settlement on the stamp, not the source (#2262)", () => {
    // A cash / off-Xero settlement is stored as an ordinary INTERNET_BANKING
    // payment, so the source alone cannot tell the two apart — and a member who
    // handed over cash must not read "Paid by bank transfer".
    expect(
      resolveConfirmationSettlementMethod({
        source: "INTERNET_BANKING",
        manuallyMarkedPaidAt: new Date("2026-07-01"),
      }),
    ).toBe("manual");
    // The same stamp on a Xero-stamped row still reads as manual: a later
    // stamper can legitimately put a Xero id on a manual row.
    expect(
      resolveConfirmationSettlementMethod({
        source: "STRIPE",
        manuallyMarkedPaidAt: new Date("2026-07-01"),
      }),
    ).toBe("manual");
  });

  it("falls back to card when no Payment row exists yet", () => {
    expect(resolveConfirmationSettlementMethod(null)).toBe("card");
  });
});
