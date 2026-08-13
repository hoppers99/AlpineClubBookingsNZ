import { beforeEach, describe, expect, it, vi } from "vitest";

import { APP_TIME_ZONE } from "@/config/operational";

/**
 * Every Xero document date derived from an INSTANT is the club's calendar day
 * (#2834, INV-DATE-019).
 *
 * New Zealand runs 12-13 hours ahead of UTC, so for roughly the first half of
 * every club day the UTC calendar date is still yesterday. Truncating an instant
 * to its UTC day therefore dated a whole morning's invoices, credit notes,
 * payments and allocations one day early — and a document's issue date decides
 * which GST period and financial year it falls in, so at a month or 1 April
 * boundary the document moved period.
 *
 * #2697 closed the two `Booking.createdAt` consumers. This suite covers the rest
 * of the family, which reached the same forbidden pattern one indirection away
 * from the spelling: through `formatDate()` in `xero-invoice-helpers.ts`, which
 * IS `toISOString().split("T")[0]`, and through a private clone of it in
 * `membership-cancellation-xero.ts`.
 *
 * **The instants are chosen so a wrong zone FAILS them.** A merely "divergent"
 * instant is not enough: 21:30Z sits ~9.5h into a 12h window and passes under any
 * zone from about UTC+10 upwards, daylight saving or not. Each case below is
 * either the first instant of a club day (which a shallower zone gets wrong) or
 * 00:30 NZDT (which a fixed +12 zone with no daylight saving gets wrong).
 *
 * Sibling coverage that needs its own scaffolding lives with it:
 * `xero-group-settlement-invoices.test.ts` (settlement due date),
 * `xero-booking-invoice.test.ts` (invoice payment date),
 * `xero-applied-credit-allocation.test.ts` (applied-credit remainder note),
 * `xero-applied-credit-deallocation.test.ts` (allocation recreate) and
 * `membership-cancellation-xero.test.ts` (cancellation credit note + allocation).
 */

const mocks = vi.hoisted(() => ({
  paymentFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  seasonFindFirst: vi.fn(),
  settlementFindUnique: vi.fn(),
  settlementUpdate: vi.fn(),
  getHutFeeItemCodeMap: vi.fn(),
  enqueueSettlementVoid: vi.fn(),
  memberCreditAggregate: vi.fn(),
  memberCreditFindMany: vi.fn(),
  memberCreditUpdateMany: vi.fn(),
  creditNoteAllocationGroupBy: vi.fn(),
  creditNoteAllocationUpsert: vi.fn(),
  creditNoteAllocationFindUnique: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  assertNoAppliedCreditDeallocationFence: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroObjectLinkFindMany: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  chargeFindUnique: vi.fn(),
  chargeUpdate: vi.fn(),
  transaction: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  findCanonicalPaymentRefundCreditNote: vi.fn(),
  sumCoveredRefundCreditNoteCents: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  getAccountMapping: vi.fn(),
  getEntranceFeeContext: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  retryXeroWriteWithContactRepair: vi.fn(),
  notifyXeroSyncError: vi.fn(),
  accountingApi: {
    createInvoices: vi.fn(),
    getInvoices: vi.fn(),
    createPayments: vi.fn(),
    createCreditNoteAllocation: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    payment: { findUnique: mocks.paymentFindUnique, update: mocks.paymentUpdate },
    booking: {
      findUnique: mocks.bookingFindUnique,
      findMany: mocks.bookingFindMany,
    },
    bookingModification: { findUnique: mocks.bookingModificationFindUnique },
    member: { findUnique: mocks.memberFindUnique },
    season: { findFirst: mocks.seasonFindFirst },
    groupBookingSettlement: {
      findUnique: mocks.settlementFindUnique,
      update: mocks.settlementUpdate,
    },
    xeroObjectLink: {
      findFirst: mocks.xeroObjectLinkFindFirst,
      findMany: mocks.xeroObjectLinkFindMany,
    },
    memberCredit: {
      aggregate: mocks.memberCreditAggregate,
      findMany: mocks.memberCreditFindMany,
      updateMany: mocks.memberCreditUpdateMany,
    },
    memberCreditNoteAllocation: {
      groupBy: mocks.creditNoteAllocationGroupBy,
      upsert: mocks.creditNoteAllocationUpsert,
      findUnique: mocks.creditNoteAllocationFindUnique,
    },
    xeroSyncOperation: { update: mocks.xeroSyncOperationUpdate },
    membershipSubscriptionCharge: {
      findUnique: mocks.chargeFindUnique,
      update: mocks.chargeUpdate,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (id: string) => `https://xero.test/invoice/${id}`,
  buildXeroCreditNoteUrl: (id: string) => `https://xero.test/credit-note/${id}`,
  stripXeroOrgShortCode: (url: string) => url,
}));

vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: mocks.notifyXeroSyncError,
}));

// `buildXeroIdempotencyKey` and `sanitizeForJson` stay real, so the recorded
// operation carries the key production would carry — which is what the
// idempotency analysis on #2834 turns on.
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
    findCanonicalPaymentRefundCreditNote: mocks.findCanonicalPaymentRefundCreditNote,
    sumCoveredRefundCreditNoteCents: mocks.sumCoveredRefundCreditNoteCents,
  };
});

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  callXeroApi: mocks.callXeroApi,
}));

vi.mock("@/lib/xero-mappings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-mappings")>();
  return {
    ...actual,
    getResolvedAccountMapping: mocks.getResolvedAccountMapping,
    getAccountMapping: mocks.getAccountMapping,
    getEntranceFeeContext: mocks.getEntranceFeeContext,
    getHutFeeItemCodeMap: mocks.getHutFeeItemCodeMap,
  };
});

vi.mock("@/lib/xero-group-settlement-void-outbox", () => ({
  enqueueXeroGroupSettlementInvoiceVoidOperation: mocks.enqueueSettlementVoid,
}));

vi.mock("@/lib/member-credit", () => ({
  lockMemberCreditLedger: mocks.lockMemberCreditLedger,
  deriveBookingAppliedCreditCents: vi.fn(),
}));

vi.mock("@/lib/xero-applied-credit-operation-serialization", () => ({
  assertNoAppliedCreditDeallocationFence: mocks.assertNoAppliedCreditDeallocationFence,
}));

vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: mocks.findOrCreateXeroContact,
  retryXeroWriteWithContactRepair: mocks.retryXeroWriteWithContactRepair,
}));

import {
  allocateCreditNoteToInvoice,
  createUnappliedXeroCreditNote,
  createXeroCreditNote,
} from "@/lib/xero-credit-notes";
import { allocateAppliedCreditForBooking } from "@/lib/xero-applied-credit-allocation";
import { createXeroEntranceFeeInvoice } from "@/lib/xero-entrance-fee-invoices";
import { createXeroInvoiceForGroupSettlement } from "@/lib/xero-group-settlement-invoices";
import {
  buildRefundCreditNotePayment,
  createXeroPaymentForInvoice,
} from "@/lib/xero-invoice-payments";
import { createXeroCreditNoteForModification } from "@/lib/xero-modification-credit-notes";
import { createXeroMembershipSubscriptionInvoice } from "@/lib/xero-subscription-invoices";
import { createXeroSupplementaryInvoice } from "@/lib/xero-supplementary-invoices";

/**
 * Each case is an instant whose UTC calendar day is the day BEFORE the club's,
 * chosen so that reading it in the wrong zone produces the wrong answer:
 *
 * - `NZST_CLUB_DAY_START` is 00:00 in Pacific/Auckland at UTC+12. Any zone
 *   shallower than +12 (Australia/Brisbane at +10, say) returns the previous day.
 * - `NZDT_JUST_AFTER_MIDNIGHT` is 00:30 in Pacific/Auckland at UTC+13. A fixed
 *   +12 zone with no daylight saving returns the previous day, so this pins the
 *   daylight-saving offset rather than merely "somewhere east of UTC".
 */
const CLUB_DAY_CASES = [
  {
    label: "NZST (UTC+12), the first instant of a club day",
    instant: new Date("2026-06-14T12:00:00.000Z"),
    utcDay: "2026-06-14",
    clubDay: "2026-06-15",
  },
  {
    label: "NZDT (UTC+13), 00:30 on a club day",
    instant: new Date("2026-01-14T11:30:00.000Z"),
    utcDay: "2026-01-14",
    clubDay: "2026-01-15",
  },
] as const;

const SENTINEL = "sentinel-stop";

function pinClubMorning(instant: Date) {
  // The root freeze pins midday NZ (2026-07-01T00:00:00.000Z), where the UTC day
  // and the club day agree — exactly the window this defect does NOT live in. Set
  // the instant per test: the root `beforeEach` only re-freezes when the clock has
  // been handed back to the real calendar, so it never overwrites this pin, and
  // never restores it either (docs/TESTING.md rule 4).
  vi.setSystemTime(instant);
}

function enqueuedOperation(index = 0) {
  return mocks.startXeroSyncOperation.mock.calls[index][0];
}

describe("#2834 the premise: the club zone is New Zealand and each instant really is divergent", () => {
  it("runs with the club time zone actually set to New Zealand", () => {
    // docs/TESTING.md rule 6: setting TZ=UTC to imitate the CI runner ALSO moves
    // APP_TIME_ZONE, because it is `process.env.TZ || NEXT_PUBLIC_TZ ||
    // "Pacific/Auckland"`. Every assertion in this file would then go red and
    // read like the product bug it proves fixed. Say what actually happened.
    expect(
      APP_TIME_ZONE,
      "This suite exists to prove the club day and the UTC day differ, so it needs the club zone to be New Zealand. TZ (or NEXT_PUBLIC_TZ) is overriding APP_TIME_ZONE — see docs/TESTING.md rule 6.",
    ).toBe("Pacific/Auckland");
  });

  it.each(CLUB_DAY_CASES)(
    "$label: the UTC day is the day before the club day",
    ({ instant, utcDay, clubDay }) => {
      // Without this a fixture that drifted out of the divergence window would
      // pass vacuously, testing nothing at all.
      expect(instant.toISOString().slice(0, 10)).toBe(utcDay);
      expect(utcDay).not.toBe(clubDay);
    },
  );
});

beforeEach(() => {
  vi.resetAllMocks();

  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: mocks.accountingApi },
    tenantId: "tenant_1",
  });
  mocks.findOrCreateXeroContact.mockResolvedValue("contact_1");
  mocks.getResolvedAccountMapping.mockResolvedValue({
    code: "200",
    itemCode: undefined,
    codeExplicitlyConfigured: false,
  });
  mocks.getAccountMapping.mockResolvedValue("606");
  mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
  mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
  mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  mocks.upsertXeroObjectLink.mockResolvedValue(undefined);
  mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue(null);
  mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
  mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
  mocks.xeroObjectLinkFindMany.mockResolvedValue([]);
  mocks.seasonFindFirst.mockResolvedValue(null);
  mocks.getHutFeeItemCodeMap.mockResolvedValue(new Map());
  mocks.callXeroApi.mockImplementation((run: () => unknown) => run());
  mocks.accountingApi.createPayments.mockResolvedValue({
    body: { payments: [{ paymentID: "pay_1" }] },
  });
  mocks.accountingApi.createCreditNoteAllocation.mockResolvedValue({ body: {} });
  mocks.accountingApi.getInvoices.mockResolvedValue({ body: { invoices: [] } });
  mocks.accountingApi.createInvoices.mockResolvedValue({
    body: { invoices: [{ invoiceID: "inv_new", invoiceNumber: "INV-9" }] },
  });
});

// ---------------------------------------------------------------------------
// Payments — bank-reconciliation input, and the date decides the GST period the
// cash falls in.
// ---------------------------------------------------------------------------

describe.each(CLUB_DAY_CASES)(
  "a Xero payment against an invoice — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", async () => {
      pinClubMorning(instant);

      await createXeroPaymentForInvoice({
        localModel: "Payment",
        localId: "pay_local",
        invoiceId: "inv_1",
        amountCents: 12500,
        idempotencyKey: "payment:pay_local:invoice-payment:v1",
        reference: "Stripe pi_1",
        role: "INVOICE_PAYMENT",
      });

      const sent = mocks.accountingApi.createPayments.mock.calls[0][1];
      expect(sent.payments[0].date).toBe(clubDay);
      expect(sent.payments[0].date).not.toBe(utcDay);
      // The key is unchanged by the derivation — see the idempotency analysis on
      // #2834. An operation queued before this shipped still dedupes after it.
      expect(enqueuedOperation().idempotencyKey).toBe(
        "payment:pay_local:invoice-payment:v1",
      );
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a Stripe-refund credit-note payment — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", () => {
      pinClubMorning(instant);

      const payment = buildRefundCreditNotePayment({
        paymentId: "pay_local",
        creditNoteId: "cn_1",
        refundAmountCents: 5000,
        bankCode: "606",
      });

      expect(payment.date).toBe(clubDay);
      expect(payment.date).not.toBe(utcDay);
    });
  },
);

// ---------------------------------------------------------------------------
// Credit notes — the half the issue calls more serious, because the date decides
// the GST period and, at 1 April, the financial year.
// ---------------------------------------------------------------------------

describe.each(CLUB_DAY_CASES)(
  "a refund credit note — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day, while the stay dates stay date-only", async () => {
      pinClubMorning(instant);
      mocks.paymentFindUnique.mockResolvedValue({
        id: "pay_local",
        xeroInvoiceId: "inv_1",
        xeroRefundCreditNoteId: null,
        refundedAmountCents: 5000,
        booking: {
          id: "booking_1234abcd",
          memberId: "mem_1",
          // `@db.Date` lodge nights: UTC midnight is the ENCODING of a calendar
          // day, so these must read back unshifted (INV-DATE-010).
          checkIn: new Date("2026-08-03T00:00:00.000Z"),
          checkOut: new Date("2026-08-05T00:00:00.000Z"),
          member: { id: "mem_1" },
          guests: [],
        },
      });
      mocks.retryXeroWriteWithContactRepair.mockRejectedValue(new Error(SENTINEL));

      await expect(createXeroCreditNote("pay_local", 5000)).rejects.toThrow(SENTINEL);

      const creditNote = enqueuedOperation().requestPayload.creditNotes[0];
      expect(creditNote.date).toBe(clubDay);
      expect(creditNote.date).not.toBe(utcDay);
      expect(creditNote.lineItems[0].description).toContain("2026-08-03 - 2026-08-05");
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "an account-credit (unapplied) credit note — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", async () => {
      pinClubMorning(instant);
      mocks.paymentFindUnique.mockResolvedValue({
        id: "pay_local",
        booking: {
          id: "booking_1234abcd",
          memberId: "mem_1",
          checkIn: new Date("2026-08-03T00:00:00.000Z"),
          checkOut: new Date("2026-08-05T00:00:00.000Z"),
          member: { id: "mem_1" },
        },
      });
      mocks.retryXeroWriteWithContactRepair.mockRejectedValue(new Error(SENTINEL));

      await expect(
        createUnappliedXeroCreditNote("pay_local", 5000),
      ).rejects.toThrow(SENTINEL);

      const creditNote = enqueuedOperation().requestPayload.creditNotes[0];
      expect(creditNote.date).toBe(clubDay);
      expect(creditNote.date).not.toBe(utcDay);
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a credit-note allocation against an invoice — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", async () => {
      pinClubMorning(instant);

      await allocateCreditNoteToInvoice("cn_1", "inv_1", 5000);

      const [, , body] = mocks.accountingApi.createCreditNoteAllocation.mock.calls[0];
      expect(body.allocations[0].date).toBe(clubDay);
      expect(body.allocations[0].date).not.toBe(utcDay);
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a booking-modification credit note and the allocation that settles it — $label",
  ({ instant, utcDay, clubDay }) => {
    it("are both dated on the club's calendar day", async () => {
      pinClubMorning(instant);
      mocks.bookingFindUnique.mockResolvedValue({
        id: "booking_1234abcd",
        memberId: "mem_1",
        payment: { xeroInvoiceId: "inv_1" },
      });
      mocks.retryXeroWriteWithContactRepair.mockResolvedValue({
        body: { creditNotes: [{ creditNoteID: "cn_1", creditNoteNumber: "CN-1" }] },
      });

      await createXeroCreditNoteForModification({
        bookingId: "booking_1234abcd",
        refundAmountCents: 5000,
        bookingModificationId: "mod_1",
      });

      const creditNote = enqueuedOperation().requestPayload.creditNotes[0];
      expect(creditNote.date).toBe(clubDay);
      expect(creditNote.date).not.toBe(utcDay);

      const [, , body] = mocks.accountingApi.createCreditNoteAllocation.mock.calls[0];
      expect(body.allocations[0].date).toBe(clubDay);
      expect(body.allocations[0].date).not.toBe(utcDay);
    });
  },
);

// ---------------------------------------------------------------------------
// Invoices — the issue date decides the GST period and the financial year.
// ---------------------------------------------------------------------------

describe.each(CLUB_DAY_CASES)(
  "a supplementary invoice for a positive booking modification — $label",
  ({ instant, utcDay, clubDay }) => {
    it("dates the invoice and its payment on the club's calendar day", async () => {
      pinClubMorning(instant);
      mocks.bookingFindUnique.mockResolvedValue({
        id: "booking_1234abcd",
        memberId: "mem_1",
        payment: { xeroInvoiceId: "inv_1" },
        member: { id: "mem_1" },
      });
      mocks.bookingModificationFindUnique.mockResolvedValue({ createdAt: instant });
      mocks.retryXeroWriteWithContactRepair.mockResolvedValue({
        body: { invoices: [{ invoiceID: "inv_supp", invoiceNumber: "INV-42" }] },
      });

      await createXeroSupplementaryInvoice({
        bookingId: "booking_1234abcd",
        priceDiffCents: 5000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      });

      const invoice = enqueuedOperation().requestPayload.invoices[0];
      expect(invoice.date).toBe(clubDay);
      expect(invoice.date).not.toBe(utcDay);

      const sentPayment = mocks.accountingApi.createPayments.mock.calls[0][1];
      expect(sentPayment.payments[0].date).toBe(clubDay);
      expect(sentPayment.payments[0].date).not.toBe(utcDay);
    });

    it("dates the due date from the modification's stored instant, on the club's calendar", async () => {
      // `BookingModification.createdAt` is a `DateTime @default(now())` — a real
      // instant, like `Booking.createdAt` on #2697, not a `@db.Date`. Pin the
      // clock somewhere the two calendars AGREE so this can only be reading the
      // stored instant, never today.
      vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
      mocks.bookingFindUnique.mockResolvedValue({
        id: "booking_1234abcd",
        memberId: "mem_1",
        payment: { xeroInvoiceId: "inv_1" },
        member: { id: "mem_1" },
      });
      mocks.bookingModificationFindUnique.mockResolvedValue({ createdAt: instant });
      mocks.retryXeroWriteWithContactRepair.mockResolvedValue({
        body: { invoices: [{ invoiceID: "inv_supp", invoiceNumber: "INV-42" }] },
      });

      await createXeroSupplementaryInvoice({
        bookingId: "booking_1234abcd",
        priceDiffCents: 5000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      });

      const invoice = enqueuedOperation().requestPayload.invoices[0];
      expect(invoice.dueDate).toBe(clubDay);
      expect(invoice.dueDate).not.toBe(utcDay);
      expect(invoice.date).toBe("2026-07-01");
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "the remainder note minted for applied credit with no floating note — $label",
  ({ instant, utcDay, clubDay }) => {
    it("is dated on the club's calendar day", async () => {
      pinClubMorning(instant);
      mocks.bookingFindUnique.mockResolvedValue({
        id: "booking_1234abcd",
        memberId: "mem_1",
        payment: { id: "pay_1", xeroInvoiceId: "inv_1" },
      });
      // 3000c of BOOKING_APPLIED credit, all of it from a noteless (admin
      // adjustment) lot, so the whole amount goes down the mint path.
      mocks.memberCreditAggregate.mockResolvedValue({
        _sum: { amountCents: -3000 },
      });
      mocks.memberCreditFindMany.mockResolvedValue([
        { id: "lot_1", amountCents: 5000, xeroCreditNoteId: null },
      ]);
      mocks.creditNoteAllocationGroupBy.mockResolvedValue([]);
      mocks.transaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
        run({
          memberCredit: {
            aggregate: mocks.memberCreditAggregate,
            findMany: mocks.memberCreditFindMany,
            updateMany: mocks.memberCreditUpdateMany,
          },
          memberCreditNoteAllocation: {
            groupBy: mocks.creditNoteAllocationGroupBy,
            upsert: mocks.creditNoteAllocationUpsert,
            findUnique: mocks.creditNoteAllocationFindUnique,
          },
        }),
      );
      mocks.retryXeroWriteWithContactRepair.mockRejectedValue(new Error(SENTINEL));

      await expect(
        allocateAppliedCreditForBooking("booking_1234abcd"),
      ).rejects.toThrow(SENTINEL);

      const creditNote = enqueuedOperation().requestPayload.creditNotes[0];
      expect(creditNote.date).toBe(clubDay);
      expect(creditNote.date).not.toBe(utcDay);
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a group-settlement invoice — $label",
  ({ instant, utcDay, clubDay }) => {
    it("takes its due date from the settlement's stored instant on the club calendar, and leaves the issue date on the lodge night", async () => {
      // The two dates on this one invoice are the clearest illustration of the
      // distinction #2834 turns on. The ISSUE date is the organiser booking's
      // check-in, a `@db.Date` lodge night that must read back unshifted
      // (INV-DATE-010). The DUE date is `GroupBookingSettlement.createdAt`, a
      // `DateTime @default(now())` — a real instant (INV-DATE-019).
      //
      // The clock is pinned somewhere the calendars agree, so the due date can
      // only be coming from the stored instant.
      vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
      mocks.transaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
        run({
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          groupBookingSettlement: { findUnique: mocks.settlementFindUnique },
        }),
      );
      mocks.settlementFindUnique.mockResolvedValue({
        id: "settle_1",
        createdAt: instant,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        groupBooking: {
          id: "group_1",
          status: "OPEN",
          organiserMemberId: "mem_1",
          organiserBookingId: "booking_organiser",
          organiserBooking: { checkIn: new Date("2026-08-03T00:00:00.000Z") },
        },
      });
      mocks.bookingFindMany.mockResolvedValue([
        {
          id: "child_1",
          status: "CONFIRMED",
          checkIn: new Date("2026-08-03T00:00:00.000Z"),
          checkOut: new Date("2026-08-05T00:00:00.000Z"),
          guests: [],
        },
      ]);
      mocks.retryXeroWriteWithContactRepair.mockRejectedValue(new Error(SENTINEL));

      await expect(
        createXeroInvoiceForGroupSettlement("settle_1"),
      ).rejects.toThrow(SENTINEL);

      const invoice = enqueuedOperation().requestPayload.invoices[0];
      expect(invoice.dueDate).toBe(clubDay);
      expect(invoice.dueDate).not.toBe(utcDay);
      expect(invoice.date).toBe("2026-08-03");
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "an entrance-fee invoice — $label",
  ({ instant, utcDay, clubDay }) => {
    it("dates the invoice on the club's calendar day and its due date thirty club days later", async () => {
      pinClubMorning(instant);
      mocks.getEntranceFeeContext.mockResolvedValue({
        exempt: false,
        category: "ADULT",
        feeMapping: {
          amountCents: 15000,
          code: "200",
          itemCode: null,
          codeExplicitlyConfigured: false,
        },
        description: null,
      });
      mocks.memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
      // Stop right after the operation records the payload, before the
      // adopt-by-reference lookups.
      mocks.callXeroApi.mockRejectedValue(new Error(SENTINEL));

      await expect(createXeroEntranceFeeInvoice("mem_1")).rejects.toThrow(SENTINEL);

      const invoice = enqueuedOperation().requestPayload.invoices[0];
      expect(invoice.date).toBe(clubDay);
      expect(invoice.date).not.toBe(utcDay);
      expect(invoice.dueDate).toBe(thirtyDaysAfter(clubDay));
    });
  },
);

describe.each(CLUB_DAY_CASES)(
  "a membership subscription invoice — $label",
  ({ instant, utcDay, clubDay }) => {
    it("dates the invoice on the club's calendar day and its due date dueDays club days later", async () => {
      pinClubMorning(instant);
      mocks.chargeFindUnique.mockResolvedValue(subscriptionCharge());
      // The transaction that persists the identifier is past the point of
      // interest; stop there rather than mocking the whole write.
      mocks.transaction.mockRejectedValue(new Error(SENTINEL));

      await expect(
        createXeroMembershipSubscriptionInvoice({
          chargeId: "charge_1",
          syncOperationId: "op_1",
        }),
      ).rejects.toThrow(SENTINEL);

      const built = mocks.accountingApi.createInvoices.mock.calls[0][1].invoices[0];
      expect(built.date).toBe(clubDay);
      expect(built.date).not.toBe(utcDay);
      expect(built.dueDate).toBe(addCalendarDays(clubDay, 30));
    });
  },
);

// ---------------------------------------------------------------------------
// Day arithmetic across the daylight-saving change.
// ---------------------------------------------------------------------------

describe("a due date counted in days is counted in CLUB days, not 24-hour blocks", () => {
  // New Zealand leaves daylight saving on 5 April 2026, so an invoice issued in
  // NZDT whose due date lands in NZST spans a 23-hour "day". Adding
  // `days x 24h` to the ISSUE INSTANT and reading the result in club time gives
  // 13 April; the correct answer, thirty CALENDAR days after 15 March, is the
  // 14th. Only date-only arithmetic gets this right.
  const issuedAt = new Date("2026-03-14T11:30:00.000Z"); // 00:30 on 15 Mar, NZDT

  it("the premise: the fixture crosses the end of daylight saving", () => {
    expect(issuedAt.toISOString().slice(0, 10)).toBe("2026-03-14");
    expect(
      new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
    ).toBe("2026-04-13");
  });

  it("dates an entrance-fee invoice's due date thirty calendar days out", async () => {
    pinClubMorning(issuedAt);
    mocks.getEntranceFeeContext.mockResolvedValue({
      exempt: false,
      category: "ADULT",
      feeMapping: {
        amountCents: 15000,
        code: "200",
        itemCode: null,
        codeExplicitlyConfigured: false,
      },
      description: null,
    });
    mocks.memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
    mocks.callXeroApi.mockRejectedValue(new Error(SENTINEL));

    await expect(createXeroEntranceFeeInvoice("mem_1")).rejects.toThrow(SENTINEL);

    const invoice = enqueuedOperation().requestPayload.invoices[0];
    expect(invoice.date).toBe("2026-03-15");
    expect(invoice.dueDate).toBe("2026-04-14");
  });

  it("dates a subscription invoice's due date dueDays calendar days out, so the adoption interval stays exact", async () => {
    pinClubMorning(issuedAt);
    mocks.chargeFindUnique.mockResolvedValue(subscriptionCharge());
    mocks.transaction.mockRejectedValue(new Error(SENTINEL));

    await expect(
      createXeroMembershipSubscriptionInvoice({
        chargeId: "charge_1",
        syncOperationId: "op_1",
      }),
    ).rejects.toThrow(SENTINEL);

    const built = mocks.accountingApi.createInvoices.mock.calls[0][1].invoices[0];
    expect(built.date).toBe("2026-03-15");
    expect(built.dueDate).toBe("2026-04-14");
    // `subscriptionInvoiceMatchesSnapshot` adopts a pre-existing Xero invoice
    // only when this interval equals the charge's frozen `dueDays`, so the
    // arithmetic has to stay exactly thirty days across the DST change.
    expect(
      (Date.parse(`${built.dueDate}T00:00:00.000Z`) -
        Date.parse(`${built.date}T00:00:00.000Z`)) /
        86_400_000,
    ).toBe(30);
  });
});

function addCalendarDays(dateOnly: string, days: number): string {
  const stepped = new Date(`${dateOnly}T00:00:00.000Z`);
  stepped.setUTCDate(stepped.getUTCDate() + days);
  return stepped.toISOString().slice(0, 10);
}

function thirtyDaysAfter(dateOnly: string): string {
  return addCalendarDays(dateOnly, 30);
}

function subscriptionCharge() {
  return {
    id: "charge_1",
    billingBasis: "ANNUAL",
    status: "QUEUED",
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    xeroInvoiceAdopted: false,
    invoicePersistedAt: null,
    recipientMemberId: "mem_1",
    xeroAccountCode: "203",
    xeroItemCode: null,
    chargedAmountCents: 20000,
    coveredMonths: 12,
    membershipTypeName: "Ordinary",
    seasonYear: 2026,
    dueDays: 30,
    invoiceReference: "SUBS-2026-mem_1",
    coverage: [],
    components: [],
  };
}
