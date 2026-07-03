import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { classifyXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";

/**
 * Property-based tests (fast-check) for the Xero-side settlement money math
 * (issue #1131, epic #1125): the booking-edit settlement classifier must route
 * every possible delta to exactly one financial action whose amounts are
 * non-negative integers matching the delta's sign, and invoice line items must
 * reconcile back to the cent ledger they were built from.
 */

const classifyInputArb = fc.record({
  hasIssuedXeroInvoice: fc.boolean(),
  originalPaymentStatus: fc.constantFrom(
    "SUCCEEDED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "PENDING",
    "PROCESSING",
    "FAILED",
    null,
    undefined
  ),
  priceDiffCents: fc.integer({ min: -200_000, max: 200_000 }),
  changeFeeCents: fc.option(fc.integer({ min: 0, max: 50_000 }), {
    nil: undefined,
  }),
  datesChanged: fc.boolean(),
  guestIdentityChanged: fc.boolean(),
  createPrimaryInvoiceWhenMissing: fc.boolean(),
  requiresAdditionalStripePayment: fc.boolean(),
  additionalPaymentIntentId: fc.option(fc.constant("pi_test_123"), {
    nil: null,
  }),
  settlementMethod: fc.constantFrom("card", "credit", null) as fc.Arbitrary<
    "card" | "credit" | null
  >,
  settlementAmountCents: fc.option(fc.integer({ min: 0, max: 200_000 }), {
    nil: null,
  }),
});

describe("classifyXeroBookingEditSettlement properties", () => {
  it("routes every delta to exactly one action whose amounts match the delta's sign", () => {
    fc.assert(
      fc.property(classifyInputArb, (input) => {
        const decision = classifyXeroBookingEditSettlement(input);
        const changeFee = input.changeFeeCents ?? 0;
        const expectedNet = input.hasIssuedXeroInvoice
          ? input.priceDiffCents + changeFee
          : 0;

        expect(decision.xeroNetAmountCents).toBe(expectedNet);

        if (!input.hasIssuedXeroInvoice) {
          expect(["primary-invoice", "none"]).toContain(
            decision.financialAction.type
          );
          expect(decision.financialAction.type).toBe(
            input.createPrimaryInvoiceWhenMissing ? "primary-invoice" : "none"
          );
          return;
        }

        if (expectedNet > 0) {
          expect(decision.financialAction.type).toBe("supplementary-invoice");
          if (decision.financialAction.type === "supplementary-invoice") {
            expect(decision.financialAction.priceDiffCents).toBe(
              Math.max(input.priceDiffCents, 0)
            );
            expect(decision.financialAction.priceDiffCents).toBeGreaterThanOrEqual(0);
            expect(decision.financialAction.changeFeeCents).toBe(changeFee);
            // A payment is recorded only when a confirmed additional Stripe
            // intent exists to wait for.
            if (decision.financialAction.recordPayment) {
              expect(decision.financialAction.waitForPaymentIntentId).not.toBeNull();
              expect(input.requiresAdditionalStripePayment).toBe(true);
            }
          }
        } else if (expectedNet < 0) {
          const refund =
            input.settlementAmountCents ?? Math.abs(expectedNet);
          if (refund <= 0) {
            expect(decision.financialAction.type).toBe("none");
          } else if (input.settlementMethod === "credit") {
            expect(decision.financialAction.type).toBe(
              "modification-account-credit-note"
            );
            if (
              decision.financialAction.type === "modification-account-credit-note"
            ) {
              expect(decision.financialAction.refundAmountCents).toBe(refund);
              expect(decision.financialAction.refundAmountCents).toBeGreaterThan(0);
            }
          } else {
            expect(decision.financialAction.type).toBe("modification-credit-note");
            if (decision.financialAction.type === "modification-credit-note") {
              expect(decision.financialAction.refundAmountCents).toBe(refund);
              expect(decision.financialAction.refundAmountCents).toBeGreaterThan(0);
            }
          }
        } else {
          expect(decision.financialAction.type).toBe("none");
        }
      })
    );
  });

  it("never queues a primary-invoice update over locally captured or refunded money", () => {
    fc.assert(
      fc.property(classifyInputArb, (input) => {
        const decision = classifyXeroBookingEditSettlement(input);
        const narrationChanged =
          Boolean(input.datesChanged) || Boolean(input.guestIdentityChanged);
        const unsafe = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(
          input.originalPaymentStatus ?? ""
        );

        if (!input.hasIssuedXeroInvoice || !narrationChanged) {
          expect(decision.primaryInvoiceUpdateAction.type).toBe("none");
        } else if (unsafe) {
          expect(decision.primaryInvoiceUpdateAction.type).toBe("skip");
        } else {
          expect(decision.primaryInvoiceUpdateAction.type).toBe("queue");
        }
      })
    );
  });
});

describe("buildInvoiceLineItems properties", () => {
  /**
   * Guests whose night rows are uniformly priced (per guest). Nights may be
   * non-contiguous, exercising the run-splitting logic; each resulting run is
   * still uniformly priced, so line totals must reconcile exactly.
   */
  const uniformGuestArb = fc.record({
    perNightCents: fc.integer({ min: 0, max: 20_000 }),
    // Day offsets inside one month; duplicates removed below.
    dayOffsets: fc.uniqueArray(fc.integer({ min: 0, max: 27 }), {
      minLength: 1,
      maxLength: 10,
    }),
    isMember: fc.boolean(),
  });

  function lineTotalCents(lines: Array<{ quantity?: number; unitAmount?: number }>) {
    return lines.reduce(
      (sum, line) =>
        sum + Math.round((line.quantity ?? 0) * (line.unitAmount ?? 0) * 100),
      0
    );
  }

  it("uniformly-priced night sets reconcile exactly to the cent ledger", () => {
    fc.assert(
      fc.property(
        fc.array(uniformGuestArb, { minLength: 1, maxLength: 5 }),
        (rawGuests) => {
          const checkIn = new Date(2026, 5, 1);
          const checkOut = new Date(2026, 5, 29);
          const guests = rawGuests.map((raw, i) => {
            const nights = raw.dayOffsets
              .sort((a, b) => a - b)
              .map((offset) => ({
                stayDate: new Date(2026, 5, 1 + offset),
                priceCents: raw.perNightCents,
              }));
            return {
              firstName: `Guest${i}`,
              lastName: "Test",
              ageTier: "ADULT",
              isMember: raw.isMember,
              priceCents: nights.reduce((s, n) => s + n.priceCents, 0),
              nights,
            };
          });

          const lines = buildInvoiceLineItems(guests, checkIn, checkOut, 28);
          const expectedTotal = guests.reduce((s, g) => s + g.priceCents, 0);
          expect(lineTotalCents(lines)).toBe(expectedTotal);
          for (const line of lines) {
            expect(line.quantity ?? 0).toBeGreaterThanOrEqual(1);
            expect(line.unitAmount ?? 0).toBeGreaterThanOrEqual(0);
          }
        }
      )
    );
  });

  // Known defect (#1163): a contiguous run with MIXED nightly prices bills
  // quantity x round(total/nights), which cannot represent the exact total.
  // This test is expected to fail until #1163 splits runs on price changes;
  // once it passes, remove the `.fails` marker.
  it.fails("mixed-price contiguous runs reconcile exactly (#1163 — currently drift by rounding)", () => {
    const checkIn = new Date(2026, 5, 1);
    const checkOut = new Date(2026, 5, 4);
    const guests = [
      {
        firstName: "Mixed",
        lastName: "Rates",
        ageTier: "ADULT",
        isMember: true,
        priceCents: 8_000,
        nights: [
          { stayDate: new Date(2026, 5, 1), priceCents: 2_500 },
          { stayDate: new Date(2026, 5, 2), priceCents: 2_500 },
          { stayDate: new Date(2026, 5, 3), priceCents: 3_000 },
        ],
      },
    ];

    const lines = buildInvoiceLineItems(guests, checkIn, checkOut, 3);
    const total = lines.reduce(
      (sum, line) =>
        sum + Math.round((line.quantity ?? 0) * (line.unitAmount ?? 0) * 100),
      0
    );
    expect(total).toBe(8_000);
  });
});
