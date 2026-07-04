import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  getAccountMapping: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  retryXeroWriteWithContactRepair: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
    },
    bookingModification: {
      findUnique: mocks.bookingModificationFindUnique,
    },
    xeroSyncOperation: {
      update: mocks.xeroSyncOperationUpdate,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (id: string) => `https://xero.example/invoice/${id}`,
}));

// Keep buildXeroIdempotencyKey / sanitizeForJson real so we can assert the actual
// key the operation records.
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  callXeroApi: mocks.callXeroApi,
}));

vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  getAccountMapping: mocks.getAccountMapping,
}));

vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: mocks.findOrCreateXeroContact,
  retryXeroWriteWithContactRepair: mocks.retryXeroWriteWithContactRepair,
}));

vi.mock("@/lib/xero-invoice-helpers", () => ({
  formatDate: () => "2026-01-01",
}));

import { createXeroSupplementaryInvoice } from "@/lib/xero-supplementary-invoices";

describe("createXeroSupplementaryInvoice idempotency-key discriminator (#1234, L2)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bookingFindUnique.mockResolvedValue({
      id: "bk1",
      memberId: "mem1",
      payment: { xeroInvoiceId: "inv_orig" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: {} },
      tenantId: "tenant_1",
    });
    mocks.findOrCreateXeroContact.mockResolvedValue("contact_1");
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "200",
      itemCode: undefined,
      codeExplicitlyConfigured: false,
    });
    mocks.getAccountMapping.mockResolvedValue("606");
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_x" });
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  });

  it("throws when bookingModificationId is absent instead of collapsing the key to bookingId", async () => {
    await expect(
      createXeroSupplementaryInvoice({
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 2000,
      })
    ).rejects.toThrow(
      "Supplementary invoice requires a bookingModificationId for a distinct Xero idempotency key"
    );

    // The guard fires before any Xero/DB work.
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("builds the Xero idempotency key from the bookingModificationId discriminator", async () => {
    // Stop the operation right after the key is recorded so we can assert it
    // without driving the full Xero write.
    mocks.retryXeroWriteWithContactRepair.mockRejectedValue(
      new Error("sentinel-stop")
    );

    await expect(
      createXeroSupplementaryInvoice({
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 2000,
        bookingModificationId: "mod_123",
      })
    ).rejects.toThrow("sentinel-stop");

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    expect(enqueued.localModel).toBe("BookingModification");
    expect(enqueued.localId).toBe("mod_123");
    // The key is scoped by the modification, not the booking, so two same-amount
    // deltas on one booking never collide.
    expect(enqueued.idempotencyKey).toBe(
      "booking-mod:mod_123:supplementary-invoice:5000:2000:v1"
    );
    expect(enqueued.correlationKey).toBe(enqueued.idempotencyKey);
    // The failed operation is marked failed and the error re-thrown.
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_x",
      expect.any(Error)
    );
  });
});
