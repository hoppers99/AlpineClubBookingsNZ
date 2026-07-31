import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  memberSubscriptionFindMany: vi.fn(),
  loadMembershipCancellationSettings: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  getInvoices: vi.fn(),
  callXeroApi: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: mocks.memberFindMany },
    memberSubscription: { findMany: mocks.memberSubscriptionFindMany },
  },
}));

vi.mock("@/lib/membership-cancellation-settings", () => ({
  loadMembershipCancellationSettings: mocks.loadMembershipCancellationSettings,
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  // Pass-through: the metering wrapper itself is not this module's job, but the
  // options handed to it (the fail-fast retry budget) are asserted below.
  callXeroApi: mocks.callXeroApi,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  classifyMembershipCancellationInvoiceCheckFailure,
  loadMembershipCancellationInvoiceBlockersByMemberId,
  MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES,
  resetMembershipCancellationInvoiceBlockerCacheForTests,
} from "@/lib/membership-cancellation-invoice-blockers";
import { getSeasonYear } from "@/lib/utils";

const NOW_MS = Date.UTC(2026, 6, 31, 3, 0, 0);

type InvoiceFixture = {
  invoiceID: string;
  invoiceNumber?: string | null;
  status?: string;
  type?: string;
  amountDue?: number;
  total?: number;
  amountPaid?: number;
  amountCredited?: number;
  currencyCode?: string;
  dueDate?: string | Date | null;
  contactID?: string;
};

function invoice(fixture: InvoiceFixture) {
  return {
    invoiceID: fixture.invoiceID,
    invoiceNumber: fixture.invoiceNumber ?? null,
    status: fixture.status ?? "AUTHORISED",
    type: fixture.type ?? "ACCREC",
    amountDue: fixture.amountDue,
    total: fixture.total,
    amountPaid: fixture.amountPaid,
    amountCredited: fixture.amountCredited,
    currencyCode: fixture.currencyCode ?? "NZD",
    dueDate: fixture.dueDate ?? "2026-06-30",
    contact: { contactID: fixture.contactID ?? "contact-1" },
  };
}

function respondWithInvoices(...pages: unknown[][]) {
  let call = 0;
  mocks.getInvoices.mockImplementation(async () => {
    const body = { invoices: pages[call] ?? [] };
    call += 1;
    return { body };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMembershipCancellationInvoiceBlockerCacheForTests();
  mocks.loadMembershipCancellationSettings.mockResolvedValue({
    warningText: "",
    rejoinProcessText: "",
    xeroArchiveContactsOnCancellation: true,
    xeroContactGroups: [],
  });
  mocks.memberFindMany.mockResolvedValue([
    { id: "member-1", xeroContactId: "contact-1" },
  ]);
  mocks.memberSubscriptionFindMany.mockResolvedValue([]);
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: { getInvoices: mocks.getInvoices } },
    tenantId: "tenant-1",
  });
  respondWithInvoices([]);
});

describe("membership cancellation unpaid-invoice blockers", () => {
  it("blocks on an authorised invoice with an amount still due", async () => {
    respondWithInvoices([
      invoice({
        invoiceID: "inv-1",
        invoiceNumber: "INV-0042",
        amountDue: 120.5,
        dueDate: "2026-06-30",
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toEqual([
      {
        type: "unpaid_invoice",
        invoiceId: "inv-1",
        invoiceNumber: "INV-0042",
        invoiceStatus: "AUTHORISED",
        direction: "receivable",
        amountDueCents: 12050,
        currency: "NZD",
        dueDate: "2026-06-30",
        xeroUrl: expect.stringContaining("inv-1"),
        // The contact link is what makes an unnumbered invoice — and any bill —
        // findable, so it is carried on every row (#2392 review, H1).
        xeroContactUrl: expect.stringContaining("contact-1"),
      },
    ]);
  });

  it("asks Xero only for the open statuses, and fails fast rather than waiting out a rate limit", async () => {
    await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
      nowMs: NOW_MS,
    });

    const args = mocks.getInvoices.mock.calls[0];
    expect(args[6]).toEqual(["contact-1"]); // contactIDs
    expect(args[7]).toEqual(["AUTHORISED", "SUBMITTED"]); // statuses
    expect(args[9]).toBe(false); // includeArchived
    expect(MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES).toEqual([
      "AUTHORISED",
      "SUBMITTED",
    ]);

    // An admin is waiting on this call, so it must drop into the "try again"
    // branch quickly rather than sit in the default two-minute rate-limit wait.
    expect(mocks.callXeroApi).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxRetries: 1, maxWaitSec: 15 }),
    );
  });

  it("blocks on a SUBMITTED invoice with a balance", async () => {
    respondWithInvoices([
      invoice({
        invoiceID: "inv-2",
        invoiceNumber: "INV-0050",
        status: "SUBMITTED",
        amountDue: 45,
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toHaveLength(1);
    expect(blockers.get("member-1")?.[0]).toMatchObject({
      invoiceStatus: "SUBMITTED",
      amountDueCents: 4500,
    });
  });

  it("does not block on paid, voided, deleted or draft invoices", async () => {
    respondWithInvoices([
      // Fully settled — Xero reports zero due even while the row is returned.
      invoice({ invoiceID: "paid", status: "PAID", amountDue: 0 }),
      invoice({ invoiceID: "voided", status: "VOIDED", amountDue: 99 }),
      invoice({ invoiceID: "deleted", status: "DELETED", amountDue: 99 }),
      invoice({ invoiceID: "draft", status: "DRAFT", amountDue: 99 }),
      // A zero-dollar authorised invoice owes nobody anything.
      invoice({ invoiceID: "zero", status: "AUTHORISED", amountDue: 0 }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toEqual([]);
  });

  it("blocks on the residual balance when a credit note only partly offsets an invoice", async () => {
    respondWithInvoices([
      invoice({
        invoiceID: "inv-part",
        invoiceNumber: "INV-0060",
        status: "AUTHORISED",
        // Xero omits AmountDue on some payloads; total - paid - credited is the
        // documented fallback, and 100 - 0 - 70 leaves 30 still owing.
        total: 100,
        amountPaid: 0,
        amountCredited: 70,
        amountDue: undefined,
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")?.[0]).toMatchObject({
      invoiceNumber: "INV-0060",
      amountDueCents: 3000,
    });
  });

  it("blocks on an unpaid bill the club owes the contact", async () => {
    respondWithInvoices([
      invoice({
        invoiceID: "bill-1",
        invoiceNumber: "BILL-9",
        type: "ACCPAY",
        amountDue: 12,
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")?.[0]).toMatchObject({
      direction: "payable",
      xeroUrl: null,
    });
  });

  it("ignores the subscription invoice this very approval is about to credit", async () => {
    mocks.memberSubscriptionFindMany.mockResolvedValue([
      { memberId: "member-1", xeroInvoiceId: "sub-invoice" },
    ]);
    respondWithInvoices([
      invoice({ invoiceID: "sub-invoice", invoiceNumber: "SUB-1", amountDue: 90 }),
      invoice({ invoiceID: "inv-other", invoiceNumber: "INV-7", amountDue: 25 }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toHaveLength(1);
    expect(blockers.get("member-1")?.[0]).toMatchObject({
      invoiceNumber: "INV-7",
    });
    expect(mocks.memberSubscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          seasonYear: getSeasonYear(new Date(NOW_MS)),
          status: { in: ["UNPAID", "OVERDUE"] },
        }),
      }),
    );
  });

  it("does not let one member's self-credited invoice excuse another sharing the same contact", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "member-1", xeroContactId: "contact-1" },
      { id: "member-2", xeroContactId: "contact-1" },
    ]);
    mocks.memberSubscriptionFindMany.mockResolvedValue([
      { memberId: "member-1", xeroInvoiceId: "sub-invoice" },
    ]);
    respondWithInvoices([
      invoice({ invoiceID: "sub-invoice", invoiceNumber: "SUB-1", amountDue: 90 }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1", "member-2"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toEqual([]);
    expect(blockers.get("member-2")).toHaveLength(1);
  });

  it("blocks an organisation contact carrying several booking invoices, oldest due first", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "school-1", xeroContactId: "contact-school" },
    ]);
    respondWithInvoices([
      invoice({
        invoiceID: "inv-b",
        invoiceNumber: "INV-0102",
        amountDue: 400,
        dueDate: "2026-08-31",
        contactID: "contact-school",
      }),
      invoice({
        invoiceID: "inv-a",
        invoiceNumber: "INV-0101",
        amountDue: 250,
        dueDate: "2026-05-31",
        contactID: "contact-school",
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["school-1"],
      { nowMs: NOW_MS },
    );

    expect(
      blockers.get("school-1")?.map((blocker) =>
        blocker.type === "unpaid_invoice" ? blocker.invoiceNumber : blocker.type,
      ),
    ).toEqual(["INV-0101", "INV-0102"]);
  });

  it("matches contacts case-insensitively", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "member-1", xeroContactId: "CONTACT-1" },
    ]);
    respondWithInvoices([
      invoice({ invoiceID: "inv-1", invoiceNumber: "INV-1", amountDue: 5, contactID: "contact-1" }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toHaveLength(1);
  });

  it("pages through Xero until a short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      invoice({ invoiceID: `page1-${index}`, amountDue: 1 }),
    );
    respondWithInvoices(fullPage, [invoice({ invoiceID: "page2-0", amountDue: 1 })]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(mocks.getInvoices).toHaveBeenCalledTimes(2);
    expect(blockers.get("member-1")).toHaveLength(101);
  });

  describe("when the check cannot run at all", () => {
    it("makes no Xero call and blocks nothing while contact archiving is off", async () => {
      mocks.loadMembershipCancellationSettings.mockResolvedValue({
        warningText: "",
        rejoinProcessText: "",
        xeroArchiveContactsOnCancellation: false,
        xeroContactGroups: [],
      });

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([]);
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      expect(mocks.memberFindMany).not.toHaveBeenCalled();
    });

    it("makes no Xero call for a member with no linked Xero contact", async () => {
      mocks.memberFindMany.mockResolvedValue([
        { id: "member-1", xeroContactId: null },
      ]);

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([]);
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      // It stops there rather than going on to work out what the cancellation
      // would have credited: with no contact there is nothing to protect.
      expect(mocks.memberSubscriptionFindMany).not.toHaveBeenCalled();
    });

    it("returns an entry for every member asked about", async () => {
      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1", "member-unknown"],
        { nowMs: NOW_MS },
      );

      expect(blockers.has("member-unknown")).toBe(true);
      expect(blockers.get("member-unknown")).toEqual([]);
    });
  });

  describe("fail-safe: an unknown answer blocks", () => {
    it("blocks with reason 'disconnected' when Xero is not connected", async () => {
      const error = new Error("Xero is not connected.");
      error.name = "XeroReconnectRequiredError";
      mocks.getAuthenticatedXeroClient.mockRejectedValue(error);

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([
        { type: "invoice_check_unavailable", reason: "disconnected" },
      ]);
    });

    it("blocks with reason 'rate_limited' when the Xero daily limit is in force", async () => {
      const error = new Error("Xero daily API limit reached.");
      error.name = "XeroDailyLimitError";
      mocks.getAuthenticatedXeroClient.mockRejectedValue(error);

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([
        { type: "invoice_check_unavailable", reason: "rate_limited" },
      ]);
    });

    it("blocks with reason 'unavailable' when Xero cannot be reached", async () => {
      mocks.getInvoices.mockRejectedValue(new Error("socket hang up"));

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([
        { type: "invoice_check_unavailable", reason: "unavailable" },
      ]);
    });

    it("leaves a member with no Xero contact unblocked even while Xero is down", async () => {
      mocks.memberFindMany.mockResolvedValue([
        { id: "member-1", xeroContactId: "contact-1" },
        { id: "member-2", xeroContactId: null },
      ]);
      mocks.getInvoices.mockRejectedValue(new Error("socket hang up"));

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1", "member-2"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toHaveLength(1);
      expect(blockers.get("member-2")).toEqual([]);
    });

    it("classifies raw Xero HTTP failures", () => {
      expect(
        classifyMembershipCancellationInvoiceCheckFailure({
          response: { statusCode: 401 },
        }),
      ).toBe("disconnected");
      expect(
        classifyMembershipCancellationInvoiceCheckFailure({
          response: { statusCode: 429 },
        }),
      ).toBe("rate_limited");
      expect(
        classifyMembershipCancellationInvoiceCheckFailure({
          response: { statusCode: 503 },
        }),
      ).toBe("unavailable");
    });

    it("never caches a failure", async () => {
      mocks.getInvoices.mockRejectedValueOnce(new Error("socket hang up"));
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });

      respondWithInvoices([]);
      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([]);
    });
  });

  describe("the review queue's memo", () => {
    it("reuses a recent answer instead of calling Xero again", async () => {
      respondWithInvoices([invoice({ invoiceID: "inv-1", amountDue: 10 })]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS + 30_000,
      });

      expect(mocks.getInvoices).toHaveBeenCalledTimes(1);
    });

    it("expires after a minute", async () => {
      respondWithInvoices([invoice({ invoiceID: "inv-1", amountDue: 10 })]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });
      respondWithInvoices([invoice({ invoiceID: "inv-1", amountDue: 10 })]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS + 61_000,
      });

      expect(mocks.getInvoices).toHaveBeenCalledTimes(2);
    });

    it("is bypassed when the caller asks for a fresh answer", async () => {
      respondWithInvoices([invoice({ invoiceID: "inv-1", amountDue: 10 })]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });

      respondWithInvoices([
        invoice({ invoiceID: "inv-2", invoiceNumber: "INV-NEW", amountDue: 10 }),
      ]);
      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS + 1_000, fresh: true },
      );

      expect(mocks.getInvoices).toHaveBeenCalledTimes(2);
      expect(blockers.get("member-1")?.[0]).toMatchObject({
        invoiceNumber: "INV-NEW",
      });
    });
  });
});
