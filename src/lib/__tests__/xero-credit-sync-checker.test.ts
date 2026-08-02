import { beforeEach, describe, expect, it, vi } from "vitest";

// The checker injects db / readInvoiceCreditAllocation / sendAlert, so these
// module mocks exist only to satisfy imports without pulling the real Prisma
// client, email stack, or Xero HTTP client into the unit test.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/email", () => ({ sendAdminCreditSyncDriftAlert: vi.fn() }));
vi.mock("@/lib/xero-api-client", () => ({
  callXeroApi: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
}));
vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (invoiceId: string) => `https://xero.test/invoice/${invoiceId}`,
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  reconcileXeroCreditSync,
  type CreditSyncInvoiceRead,
} from "@/lib/xero-credit-sync-checker";
import type { CreditSyncDriftReportEmail } from "@/lib/email-templates";

interface FakeDbState {
  cronJobRun: unknown;
  /** Bookings with >=1 stamped BOOKING_APPLIED row (the checker's population). */
  stampedPopulationIds: string[];
  /** Net applied credit (positive cents) over ALL BOOKING_APPLIED rows. */
  netCentsByBooking: Record<string, number>;
  bookings: Array<{
    id: string;
    member: { firstName: string; lastName: string };
    payment: { id: string | null; xeroInvoiceId: string | null } | null;
  }>;
  inFlightOpBookingPaymentIds: Set<string>;
}

function makeDb(state: FakeDbState) {
  return {
    cronJobRun: {
      findFirst: vi.fn(async () => state.cronJobRun),
    },
    memberCredit: {
      groupBy: vi.fn(async (args: { where?: { xeroCreditNoteId?: unknown } }) => {
        // The population query filters on a stamped credit-note id; the metric
        // query does not. Branch on that to serve the right shape.
        if (args.where?.xeroCreditNoteId) {
          return state.stampedPopulationIds.map((id) => ({
            appliedToBookingId: id,
            _count: { _all: 1 },
          }));
        }
        return Object.entries(state.netCentsByBooking).map(([id, cents]) => ({
          appliedToBookingId: id,
          _sum: { amountCents: -cents },
        }));
      }),
    },
    booking: {
      findMany: vi.fn(async () => state.bookings),
    },
    xeroSyncOperation: {
      findFirst: vi.fn(async ({ where }: { where: { localId: string } }) =>
        state.inFlightOpBookingPaymentIds.has(where.localId) ? { id: "op_1" } : null
      ),
    },
  } as unknown as typeof import("@/lib/prisma").prisma;
}

function bookingRow(
  id: string,
  xeroInvoiceId: string | null,
  first = "Ada",
  last = "Lovelace"
) {
  return {
    id,
    member: { firstName: first, lastName: last },
    payment: { id: `pay_${id}`, xeroInvoiceId },
  };
}

function invoiceRead(
  amountCreditedCents: number | null,
  notes: CreditSyncInvoiceRead["notes"] = []
): CreditSyncInvoiceRead {
  return {
    found: amountCreditedCents !== null,
    amountCreditedCents,
    invoiceNumber: "INV-001",
    notes,
  };
}

describe("reconcileXeroCreditSync", () => {
  let sendAlert: ReturnType<
    typeof vi.fn<(report: CreditSyncDriftReportEmail) => Promise<void>>
  >;

  beforeEach(() => {
    sendAlert = vi.fn<(report: CreditSyncDriftReportEmail) => Promise<void>>(
      async () => {}
    );
  });

  it("reports no drift and sends no email when BookingApp and Xero agree", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () => invoiceRead(12000),
      sendAlert,
    });

    expect(result).toMatchObject({
      skipped: false,
      scannedBookings: 1,
      checkedBookings: 1,
      deferredBookings: 0,
      driftBookings: 0,
      totalDriftCents: 0,
      completePass: true,
      emailSent: false,
    });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("reconciles a COMPLETED clamp deallocation via the net-of-all metric (no false drift)", async () => {
    // Stamped rows still sum to -$120, but the #1887 clamp appended an unstamped
    // +$20 offset and the deallocation reduced the invoice to $100. Netting all
    // rows gives $100, which matches Xero — summing stamped rows alone would
    // have falsely reported $20 of drift.
    const db = makeDb({
      cronJobRun: null,
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 10000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () => invoiceRead(10000),
      sendAlert,
    });

    expect(result.driftBookings).toBe(0);
    expect(result.checkedBookings).toBe(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("warns with the EXACT shortfall when Xero has less allocated than BookingApp recorded", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 0,
      // Xero shows only $30 allocated where BookingApp believes $120.
      readInvoiceCreditAllocation: async () =>
        invoiceRead(3000, [
          { creditNoteId: "cn_1", creditNoteNumber: "CN-9", appliedCents: 3000 },
        ]),
      sendAlert,
    });

    expect(result.driftBookings).toBe(1);
    expect(result.totalDriftCents).toBe(9000);
    expect(result.emailSent).toBe(true);
    expect(sendAlert).toHaveBeenCalledTimes(1);

    const report = sendAlert.mock.calls[0][0] as CreditSyncDriftReportEmail;
    expect(report.drifts).toEqual([
      {
        kind: "missing_in_xero",
        bookingId: "bk_1",
        memberName: "Ada Lovelace",
        invoiceId: "inv_1",
        invoiceNumber: "INV-001",
        invoiceUrl: "https://xero.test/invoice/inv_1",
        localCents: 12000,
        xeroCents: 3000,
        deltaCents: 9000,
        notes: [{ creditNoteId: "cn_1", creditNoteNumber: "CN-9", appliedCents: 3000 }],
      },
    ]);
  });

  it("warns with the EXACT excess when Xero has more allocated than BookingApp recorded", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 5000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () => invoiceRead(8000),
      sendAlert,
    });

    expect(result.driftBookings).toBe(1);
    expect(result.totalDriftCents).toBe(3000);
    const report = sendAlert.mock.calls[0][0] as CreditSyncDriftReportEmail;
    expect(report.drifts[0]).toMatchObject({
      kind: "excess_in_xero",
      localCents: 5000,
      xeroCents: 8000,
      deltaCents: 3000,
    });
  });

  it("flags applied credit that has no linked Xero invoice", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 4200 },
      bookings: [bookingRow("bk_1", null, "Grace", "Hopper")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const readInvoice = vi.fn(async () => invoiceRead(0));
    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(readInvoice).not.toHaveBeenCalled();
    expect(result.driftBookings).toBe(1);
    const report = sendAlert.mock.calls[0][0] as CreditSyncDriftReportEmail;
    expect(report.drifts[0]).toMatchObject({
      kind: "no_invoice",
      localCents: 4200,
      xeroCents: 0,
      deltaCents: 4200,
      invoiceId: null,
      invoiceUrl: null,
    });
  });

  it("DEFERS (no false warning) when the Xero read fails — fail-safe", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () => {
        throw new Error("Xero temporarily unavailable");
      },
      sendAlert,
    });

    expect(result.deferredBookings).toBe(1);
    expect(result.checkedBookings).toBe(0);
    expect(result.driftBookings).toBe(0);
    expect(result.completePass).toBe(false);
    expect(result.emailSent).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("DEFERS a booking whose allocation is still in flight (not drift)", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(["pay_bk_1"]),
    });

    const readInvoice = vi.fn(async () => invoiceRead(0));
    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(readInvoice).not.toHaveBeenCalled();
    expect(result.deferredBookings).toBe(1);
    expect(result.driftBookings).toBe(0);
    expect(result.completePass).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("DEFERS on a degraded payload with an unreadable amountCredited", async () => {
    const db = makeDb({
      cronJobRun: null,
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: async () => ({
        found: true,
        amountCreditedCents: null,
        invoiceNumber: null,
        notes: [],
      }),
      sendAlert,
    });

    expect(result.deferredBookings).toBe(1);
    expect(result.driftBookings).toBe(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("is idempotent: a re-run over an in-sync ledger reports the same zero drift", async () => {
    const state: FakeDbState = {
      cronJobRun: null,
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 7500 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    };
    const read = async () => invoiceRead(7500);

    const first = await reconcileXeroCreditSync({
      db: makeDb(state),
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: read,
      sendAlert,
    });
    const second = await reconcileXeroCreditSync({
      db: makeDb(state),
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: read,
      sendAlert,
    });

    expect(first).toEqual(second);
    expect(first.driftBookings).toBe(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("throttles: a complete pass within the recheck interval skips real Xero work", async () => {
    const readInvoice = vi.fn(async () => invoiceRead(0));
    const db = makeDb({
      cronJobRun: {
        startedAt: new Date(),
        resultSummary: { completePass: true },
      },
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 12000 },
      bookings: [],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 20 * 60 * 60 * 1000,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/throttled/i);
    expect(readInvoice).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("does NOT throttle when the last pass was incomplete (e.g. a prior Xero outage)", async () => {
    const readInvoice = vi.fn(async () => invoiceRead(12000));
    const db = makeDb({
      cronJobRun: {
        startedAt: new Date(),
        resultSummary: { completePass: false },
      },
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 12000 },
      bookings: [bookingRow("bk_1", "inv_1")],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 20 * 60 * 60 * 1000,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(result.skipped).toBe(false);
    expect(readInvoice).toHaveBeenCalledTimes(1);
    expect(result.checkedBookings).toBe(1);
  });

  it("ignores population bookings whose net applied credit is zero (fully clamped)", async () => {
    const readInvoice = vi.fn(async () => invoiceRead(0));
    const db = makeDb({
      cronJobRun: null,
      // A stamped booking whose negative applied row is fully offset by the
      // #1887 positive clamp offset — net zero, no live credit to reconcile.
      stampedPopulationIds: ["bk_1"],
      netCentsByBooking: { bk_1: 0 },
      bookings: [],
      inFlightOpBookingPaymentIds: new Set(),
    });

    const result = await reconcileXeroCreditSync({
      db,
      minRecheckIntervalMs: 0,
      readInvoiceCreditAllocation: readInvoice,
      sendAlert,
    });

    expect(result.scannedBookings).toBe(0);
    expect(result.completePass).toBe(true);
    expect(readInvoice).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
