import { beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice } from "xero-node";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  subscriptionUpsert: vi.fn(),
  getInvoice: vi.fn(),
  getInvoices: vi.fn(),
  startOperation: vi.fn(),
  completeOperation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    memberSubscription: {
      findUnique: mocks.subscriptionFindUnique,
      upsert: mocks.subscriptionUpsert,
    },
  },
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  requiresPaidSubscriptionForAgeTierFromSettings: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/member-subscription-defaults", () => ({
  roleNeverRequiresSubscription: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/xero-api-client", () => ({
  XeroDailyLimitError: class XeroDailyLimitError extends Error {},
  getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
    tenantId: "tenant-1",
    xero: {
      accountingApi: {
        getInvoice: mocks.getInvoice,
        getInvoices: mocks.getInvoices,
        getOnlineInvoice: vi.fn(),
      },
    },
  }),
  callXeroApi: vi.fn(async (callback: () => Promise<unknown>) => callback()),
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn().mockReturnValue("sync-key"),
  startXeroSyncOperation: mocks.startOperation,
  completeXeroSyncOperation: mocks.completeOperation,
  failXeroSyncOperation: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { checkMembershipStatus } from "@/lib/xero-membership-sync";

describe("membership charge reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberFindUnique.mockResolvedValue({
      id: "family-member-2",
      role: "USER",
      ageTier: "ADULT",
      xeroContactId: null,
    });
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: "subscription-2",
      status: "UNPAID",
      xeroInvoiceId: "invoice-family",
      xeroInvoiceNumber: "INV-42",
      xeroOnlineInvoiceUrl: "https://in.xero.com/invoice-family",
      paidAt: null,
      chargeCoverage: {
        charge: { xeroInvoiceId: "invoice-family" },
      },
    });
    mocks.startOperation.mockResolvedValue({ id: "operation-1" });
    mocks.subscriptionUpsert.mockResolvedValue({ id: "subscription-2" });
    mocks.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "invoice-family",
            invoiceNumber: "INV-42",
            type: Invoice.TypeEnum.ACCREC,
            status: Invoice.StatusEnum.AUTHORISED,
            dueDate: new Date("2099-04-30T00:00:00.000Z"),
          },
        ],
      },
    });
  });

  it("refreshes a non-recipient family subscription by its immutable charge invoice", async () => {
    const result = await checkMembershipStatus("family-member-2", 2026);

    expect(result).toMatchObject({
      status: "UNPAID",
      xeroInvoiceId: "invoice-family",
    });
    expect(mocks.getInvoice).toHaveBeenCalledWith("tenant-1", "invoice-family");
    expect(mocks.getInvoices).not.toHaveBeenCalled();
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "UNPAID",
          xeroInvoiceId: "invoice-family",
        }),
      })
    );
  });
});
