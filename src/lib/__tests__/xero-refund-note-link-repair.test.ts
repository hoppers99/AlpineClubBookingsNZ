import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2901 operator repair: reactivates Stripe per-delta refund credit-note links
 * the pre-#2901 canonical cleanup wrongly deactivated, deactivates local
 * mirrors of notes voided in Xero, and refuses everything else. Backed by a
 * small stateful in-memory Prisma fake so the guarded updateMany claims run
 * against real row state rather than canned returns.
 */

interface FakeLinkRow {
  id: string;
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  role: string;
  active: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

interface FakePaymentRow {
  id: string;
  bookingId: string;
  source: string;
  refundedAmountCents: number;
  createdAt: Date;
}

interface FakeOperationRow {
  id: string;
  direction: string;
  entityType: string;
  operationType: string;
  localModel: string;
  localId: string;
  xeroObjectId: string | null;
  requestPayload: unknown;
  createdAt: Date;
}

const state = vi.hoisted(() => ({
  payments: [] as FakePaymentRow[],
  links: [] as FakeLinkRow[],
  operations: [] as FakeOperationRow[],
}));

const fakePrisma = vi.hoisted(() => {
  const matchesLinkWhere = (
    row: FakeLinkRow,
    where: Record<string, unknown>
  ): boolean => {
    if (where.localModel !== undefined && row.localModel !== where.localModel) return false;
    if (where.localId !== undefined && row.localId !== where.localId) return false;
    if (where.xeroObjectType !== undefined && row.xeroObjectType !== where.xeroObjectType) return false;
    if (where.role !== undefined && row.role !== where.role) return false;
    if (typeof where.active === "boolean" && row.active !== where.active) return false;
    const idFilter = where.id as { in?: string[] } | undefined;
    if (idFilter?.in && !idFilter.in.includes(row.id)) return false;
    return true;
  };

  const client = {
    payment: {
      findMany: async (args: {
        where: {
          source?: string;
          refundedAmountCents?: { gt: number };
          id?: { in: string[] };
        };
      }) =>
        state.payments
          .filter((row) => {
            if (args.where.source && row.source !== args.where.source) return false;
            if (
              args.where.refundedAmountCents &&
              !(row.refundedAmountCents > args.where.refundedAmountCents.gt)
            ) {
              return false;
            }
            if (args.where.id?.in && !args.where.id.in.includes(row.id)) return false;
            return true;
          })
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((row) => ({
            id: row.id,
            bookingId: row.bookingId,
            refundedAmountCents: row.refundedAmountCents,
          })),
      findUnique: async (args: { where: { id: string } }) => {
        const row = state.payments.find((payment) => payment.id === args.where.id);
        if (!row) return null;
        return {
          id: row.id,
          bookingId: row.bookingId,
          source: row.source,
          refundedAmountCents: row.refundedAmountCents,
        };
      },
    },
    xeroObjectLink: {
      findMany: async (args: { where: Record<string, unknown> }) =>
        state.links
          .filter((row) => matchesLinkWhere(row, args.where))
          .map((row) => ({
            id: row.id,
            xeroObjectId: row.xeroObjectId,
            xeroObjectNumber: row.xeroObjectNumber,
            active: row.active,
            metadata: row.metadata,
            createdAt: row.createdAt,
          })),
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: { active: boolean };
      }) => {
        const rows = state.links.filter((row) => matchesLinkWhere(row, args.where));
        for (const row of rows) {
          row.active = args.data.active;
        }
        return { count: rows.length };
      },
    },
    xeroSyncOperation: {
      findFirst: async (args: {
        where: { localId: string; xeroObjectId: string };
      }) => {
        const matches = state.operations
          .filter(
            (row) =>
              row.localId === args.where.localId &&
              row.xeroObjectId === args.where.xeroObjectId
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const row = matches[0];
        return row ? { requestPayload: row.requestPayload } : null;
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
  };
  return client;
});

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  applyStripeRefundNoteLinkRepairs,
  findStripeRefundNoteLinkRepairs,
  formatStripeRefundNoteLinkRepairReport,
} from "@/lib/xero-refund-note-link-repair";

let nextId = 0;
function makeLink(overrides: Partial<FakeLinkRow>): FakeLinkRow {
  nextId += 1;
  return {
    id: `link_${nextId}`,
    localModel: "Payment",
    localId: "pay_1",
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: `cn_${nextId}`,
    xeroObjectNumber: null,
    role: "REFUND_CREDIT_NOTE",
    active: false,
    metadata: null,
    createdAt: new Date(`2026-05-0${Math.min(9, nextId)}T00:00:00Z`),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 0;
  state.payments = [
    {
      id: "pay_1",
      bookingId: "book_1",
      source: "STRIPE",
      refundedAmountCents: 100,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    },
  ];
  state.links = [];
  state.operations = [];
});

describe("findStripeRefundNoteLinkRepairs", () => {
  it("plans reactivation of the wrongly deactivated per-delta links, oldest first, to exactly the refunded total", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90 },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs();

    expect(report.scannedPayments).toBe(1);
    expect(report.plans).toHaveLength(1);
    const plan = report.plans[0];
    expect(plan).toMatchObject({
      paymentId: "pay_1",
      refundedAmountCents: 100,
      activeCoveredCents: 10,
      plannedCoveredCents: 100,
      repairable: true,
      manualReviewReason: null,
      reactivateLinkIds: ["link_90"],
      deactivateLinkIds: [],
    });
  });

  it("recovers a legacy link's amount from the persisted create-operation payload", async () => {
    state.links = [
      makeLink({
        id: "link_legacy_90",
        xeroObjectId: "cn_legacy",
        active: false,
        metadata: null, // pre-#1162 links carried no amountCents
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];
    state.operations = [
      {
        id: "op_1",
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectId: "cn_legacy",
        requestPayload: { allocation: { amount: 0.9 } }, // dollars
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ];

    const report = await findStripeRefundNoteLinkRepairs();

    const plan = report.plans[0];
    expect(plan.repairable).toBe(true);
    expect(plan.reactivateLinkIds).toEqual(["link_legacy_90"]);
    const legacy = plan.links.find((link) => link.linkId === "link_legacy_90");
    expect(legacy?.amountCents).toBe(90);
  });

  it("never reactivates voided, amount-less, or over-covering links, and reports the payment for manual review when coverage cannot land exactly", async () => {
    state.links = [
      makeLink({
        id: "link_voided",
        xeroObjectId: "cn_voided",
        active: false,
        metadata: { amountCents: 90, status: "VOIDED" },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_no_amount",
        xeroObjectId: "cn_mystery",
        active: false,
        metadata: null,
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
      makeLink({
        id: "link_too_big",
        xeroObjectId: "cn_big",
        active: false,
        metadata: { amountCents: 95 },
        createdAt: new Date("2026-05-03T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-04T00:00:00Z"),
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs();

    const plan = report.plans[0];
    expect(plan.repairable).toBe(false);
    expect(plan.reactivateLinkIds).toEqual([]);
    expect(plan.manualReviewReason).toContain("exactly on the refunded total");
    expect(
      plan.links.find((link) => link.linkId === "link_voided")?.plannedAction
    ).toBe("leave-inactive");
    expect(
      plan.links.find((link) => link.linkId === "link_no_amount")?.plannedAction
    ).toBe("leave-inactive");
    expect(
      plan.links.find((link) => link.linkId === "link_too_big")?.plannedAction
    ).toBe("leave-inactive");
  });

  it("plans deactivation of an active link whose note was voided in Xero, replacing its coverage from inactive siblings", async () => {
    state.links = [
      makeLink({
        id: "link_90_good",
        xeroObjectId: "cn_90_good",
        active: false,
        metadata: { amountCents: 90 },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_90_voided",
        xeroObjectId: "cn_90_voided",
        active: true,
        metadata: { amountCents: 90, status: "VOIDED" },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-03T00:00:00Z"),
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs();

    const plan = report.plans[0];
    expect(plan).toMatchObject({
      repairable: true,
      deactivateLinkIds: ["link_90_voided"],
      reactivateLinkIds: ["link_90_good"],
      plannedCoveredCents: 100,
    });
  });

  it("does not report healthy payments, non-Stripe payments, or unrelated links", async () => {
    state.payments.push({
      id: "pay_ib",
      bookingId: "book_ib",
      source: "INTERNET_BANKING",
      refundedAmountCents: 100,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
    state.links = [
      makeLink({
        id: "link_100",
        xeroObjectId: "cn_100",
        active: true,
        metadata: { amountCents: 100 },
      }),
      // Unrelated roles/types on the same payment must never enter a plan.
      makeLink({
        id: "link_account_credit",
        xeroObjectId: "cn_acct",
        role: "ACCOUNT_CREDIT_NOTE",
        active: false,
        metadata: { amountCents: 40 },
      }),
      makeLink({
        id: "link_invoice",
        xeroObjectId: "inv_1",
        xeroObjectType: "INVOICE",
        role: "PRIMARY_INVOICE",
        active: false,
      }),
      // A damaged link on the non-Stripe payment is out of scope here.
      makeLink({
        id: "link_ib",
        localId: "pay_ib",
        xeroObjectId: "cn_ib",
        active: false,
        metadata: { amountCents: 100 },
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs();

    expect(report.scannedPayments).toBe(1);
    expect(report.plans).toEqual([]);
  });
});

describe("applyStripeRefundNoteLinkRepairs", () => {
  it("applies the repairable plan with guarded claims and is idempotent on a second run", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90 },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_90_voided",
        xeroObjectId: "cn_90_voided",
        active: true,
        metadata: { amountCents: 90, status: "VOIDED" },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-03T00:00:00Z"),
      }),
    ];

    const first = await applyStripeRefundNoteLinkRepairs();

    expect(first.appliedPayments).toBe(1);
    expect(first.reactivatedLinks).toBe(1);
    expect(first.deactivatedLinks).toBe(1);
    expect(first.skippedPayments).toEqual([]);
    expect(state.links.find((link) => link.id === "link_90")?.active).toBe(true);
    expect(state.links.find((link) => link.id === "link_90_voided")?.active).toBe(false);
    expect(state.links.find((link) => link.id === "link_10")?.active).toBe(true);

    const second = await applyStripeRefundNoteLinkRepairs();

    expect(second.report.plans).toEqual([]);
    expect(second.appliedPayments).toBe(0);
    expect(second.reactivatedLinks).toBe(0);
    expect(second.deactivatedLinks).toBe(0);
  });

  it("skips a payment whose link state changed between the dry-run plan and the transaction snapshot", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        active: false,
        metadata: { amountCents: 90 },
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
        createdAt: new Date("2026-05-02T00:00:00Z"),
      }),
    ];

    // Concurrent writer flips link_90 active after the dry-run read: simulate
    // by intercepting the in-transaction payment re-read.
    const originalFindUnique = fakePrisma.payment.findUnique;
    const findUniqueSpy = vi
      .spyOn(fakePrisma.payment, "findUnique")
      .mockImplementation(async (args) => {
        const link = state.links.find((row) => row.id === "link_90");
        if (link) {
          link.active = true;
        }
        return originalFindUnique(args);
      });

    const result = await applyStripeRefundNoteLinkRepairs();

    findUniqueSpy.mockRestore();
    expect(result.appliedPayments).toBe(0);
    expect(result.skippedPayments).toHaveLength(1);
    expect(result.skippedPayments[0].paymentId).toBe("pay_1");
    // The concurrent activation of link_90 completed the coverage itself, so
    // the fresh in-transaction plan has nothing to do and the apply declines.
    expect(state.links.filter((row) => row.active)).toHaveLength(2);
  });

  it("reports over-covered payments for manual review and applies nothing", async () => {
    state.links = [
      makeLink({
        id: "link_90_a",
        xeroObjectId: "cn_90_a",
        active: true,
        metadata: { amountCents: 90 },
      }),
      makeLink({
        id: "link_90_b",
        xeroObjectId: "cn_90_b",
        active: true,
        metadata: { amountCents: 90 },
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];

    const result = await applyStripeRefundNoteLinkRepairs();

    expect(result.appliedPayments).toBe(0);
    expect(result.skippedPayments).toHaveLength(1);
    expect(result.skippedPayments[0].reason).toContain("Void the surplus notes in Xero");
    expect(state.links.every((row) => row.active)).toBe(true);
  });
});

describe("formatStripeRefundNoteLinkRepairReport", () => {
  it("renders a per-payment, per-link plain-text plan", async () => {
    state.links = [
      makeLink({
        id: "link_90",
        xeroObjectId: "cn_90",
        xeroObjectNumber: "CN-0090",
        active: false,
        metadata: { amountCents: 90 },
      }),
      makeLink({
        id: "link_10",
        xeroObjectId: "cn_10",
        active: true,
        metadata: { amountCents: 10 },
      }),
    ];

    const report = await findStripeRefundNoteLinkRepairs();
    const text = formatStripeRefundNoteLinkRepairReport(report);

    expect(text).toContain("1 need repair or review");
    expect(text).toContain("Payment pay_1 (booking book_1)");
    expect(text).toContain("REPAIRABLE");
    expect(text).toContain("[reactivate] note CN-0090");
    expect(text).toContain("[keep-active] note cn_10");
  });
});
