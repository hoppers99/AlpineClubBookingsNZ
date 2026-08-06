import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// -----------------------------------------------------------------------------
// #2089: the 422 create-gate mapping must fire only for the shrunk required set
// (name + email). A sparse member (name + email only) pushes through; a member
// missing email/name returns 422 listing only those fields. The duplicate
// pre-check (409 + suggestedContacts) is unchanged.
// -----------------------------------------------------------------------------

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockMemberFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: (...a: unknown[]) => mockMemberFindUnique(...a) } },
}));

const mockCreate = vi.fn();
const mockFindPotential = vi.fn();
const mockFlush = vi.fn();
const mockSyncHistory = vi.fn();
const mockLogAudit = vi.fn();
// Fully stub the Xero barrel. XeroContactValidationError is defined HERE so the
// route's `instanceof` check (which imports the same mocked class) matches when
// the test rejects createXeroContactForMember with it.
vi.mock("@/lib/xero", () => {
  class XeroContactValidationError extends Error {
    missingFields: string[];
    constructor(missingFields: string[]) {
      super(
        `Member is missing required fields for Xero contact creation: ${missingFields.join(", ")}`
      );
      this.name = "XeroContactValidationError";
      this.missingFields = missingFields;
    }
  }
  class XeroContactCreatePartialSuccessError extends Error {
    constructor(
      readonly phase:
        | "PROVIDER_CONTACT_CREATED"
        | "LOCAL_MEMBER_LINK_COMMITTED",
      readonly xeroContactId: string,
      readonly originalError: unknown,
    ) {
      super("Xero contact creation completed only in part");
      this.name = "XeroContactCreatePartialSuccessError";
    }
  }
  return {
    XeroContactCreatePartialSuccessError,
    XeroContactValidationError,
    createXeroContactForMember: (...a: unknown[]) => mockCreate(...a),
    findPotentialXeroContactsForMember: (...a: unknown[]) => mockFindPotential(...a),
    flushMemberSubscriptionHistory: (...a: unknown[]) => mockFlush(...a),
    syncMemberSubscriptionHistoryForLinkedContact: (...a: unknown[]) =>
      mockSyncHistory(...a),
  };
});

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: (id: string) => `https://go.xero.com/app/contacts/contact/${id}`,
}));
vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: () => ({
    handled: true,
    diagnosticMessage: "diag",
    clientMessage: "Failed to create Xero contact",
    status: 502,
  }),
}));
vi.mock("@/lib/utils", () => ({ getSeasonYear: () => 2026 }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroEntranceFeeInvoiceOperation: vi.fn(),
  processQueuedXeroOutboxOperations: vi.fn(),
}));

import { POST } from "@/app/api/admin/members/[id]/xero-push/route";
import {
  XeroContactCreatePartialSuccessError,
  XeroContactValidationError,
} from "@/lib/xero";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

function okGuard(userId = "admin-1") {
  return { ok: true as const, session: { user: { id: userId } } };
}
function forbiddenGuard() {
  return {
    ok: false as const,
    response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  };
}

function postReq(body: unknown = {}) {
  return new NextRequest("http://localhost/api/admin/members/mem_1/xero-push", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ id: "mem_1" });

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(okGuard());
  mockMemberFindUnique.mockResolvedValue({
    id: "mem_1",
    firstName: "Alice",
    lastName: "Example",
    email: "alice@example.org",
    xeroContactId: null,
  });
  mockFindPotential.mockResolvedValue([]);
  mockFlush.mockResolvedValue({ seasonYears: [], deletedCount: 0 });
  mockSyncHistory.mockResolvedValue({ errors: [], seasonYears: [] });
});

describe("POST /api/admin/members/[id]/xero-push (#2089)", () => {
  it("gates on finance:edit", async () => {
    mockCreate.mockResolvedValue("contact-1");
    await POST(postReq(), { params });
    expect(mockRequireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
  });

  it("403s a caller without finance:edit", async () => {
    mockRequireAdmin.mockResolvedValue(forbiddenGuard());
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a sparse member (name + email only)", async () => {
    mockCreate.mockResolvedValue("contact-1");
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.xeroContactId).toBe("contact-1");
    expect(mockCreate).toHaveBeenCalledWith("mem_1", {
      createdByMemberId: "admin-1",
    });
  });

  it("maps the create-gate validation error to 422 listing only email", async () => {
    mockCreate.mockRejectedValue(new XeroContactValidationError(["Email"]));
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.missingFields).toEqual(["Email"]);
    expect(body.error).toBe("Complete these fields before creating in Xero: Email");
  });

  it("maps a missing-name validation error to 422 listing only name fields", async () => {
    mockCreate.mockRejectedValue(
      new XeroContactValidationError(["First Name", "Last Name"])
    );
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.missingFields).toEqual(["First Name", "Last Name"]);
  });

  it("returns 409 with suggestedContacts when duplicates are found (unchanged)", async () => {
    mockFindPotential.mockResolvedValue([
      { contactId: "c9", name: "Alice Example", email: "alice@example.org" },
    ]);
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.suggestedContacts).toHaveLength(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips the duplicate pre-check when forceCreate is set", async () => {
    mockCreate.mockResolvedValue("contact-1");
    const res = await POST(postReq({ forceCreate: true }), { params });
    expect(res.status).toBe(200);
    expect(mockFindPotential).not.toHaveBeenCalled();
  });

  it("returns 409 when the member is already linked", async () => {
    mockMemberFindUnique.mockResolvedValue({
      id: "mem_1",
      firstName: "Alice",
      lastName: "Example",
      email: "alice@example.org",
      xeroContactId: "already-linked",
    });
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("marks a newly created contact as linked when history refresh is deferred", async () => {
    mockCreate.mockResolvedValue("contact-1");
    mockSyncHistory.mockRejectedValue(new HostingCoverageParticipantRetryError());

    const res = await POST(postReq(), { params });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      memberId: "mem_1",
      xeroContactCreated: true,
      xeroContactLinked: true,
      xeroContactId: "contact-1",
      recoveryKind: "CONTACT_CREATED_AND_LINKED",
      subscriptionRefreshPending: true,
      xeroPostProcessingPending: true,
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("reports provider-created without claiming a failed local link", async () => {
    mockCreate.mockRejectedValue(
      new XeroContactCreatePartialSuccessError(
        "PROVIDER_CONTACT_CREATED",
        "contact-provider-only",
        new Error("private database detail"),
      ),
    );

    const res = await POST(postReq(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      code: "XERO_PARTIAL_SUCCESS",
      error:
        "A Xero contact was created, but its local member link could not be confirmed. Do not create another contact. Reload the member, search Xero for the contact, and link it if needed.",
      recoveryKind: "CONTACT_CREATED_LINK_UNCONFIRMED",
      memberId: "mem_1",
      xeroContactCreated: true,
      xeroContactId: "contact-provider-only",
      xeroPostProcessingPending: true,
    });
    expect(body).not.toHaveProperty("xeroContactLinked");
    expect(JSON.stringify(body)).not.toContain("private database detail");
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it("reports a committed local link when helper bookkeeping fails", async () => {
    mockCreate.mockRejectedValue(
      new XeroContactCreatePartialSuccessError(
        "LOCAL_MEMBER_LINK_COMMITTED",
        "contact-linked",
        new Error("private operation detail"),
      ),
    );

    const res = await POST(postReq(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(
      expect.objectContaining({
        code: "XERO_PARTIAL_SUCCESS",
        recoveryKind: "CONTACT_CREATED_AND_LINKED",
        xeroContactCreated: true,
        xeroContactLinked: true,
        xeroContactId: "contact-linked",
        subscriptionRefreshPending: true,
        xeroPostProcessingPending: true,
      }),
    );
    expect(JSON.stringify(body)).not.toContain("private operation detail");
  });

  it("preserves the linked fact when subscription cleanup fails after create", async () => {
    mockCreate.mockResolvedValue("contact-linked");
    mockFlush.mockRejectedValue(new Error("private cleanup detail"));

    const res = await POST(postReq(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(
      expect.objectContaining({
        code: "XERO_PARTIAL_SUCCESS",
        recoveryKind: "CONTACT_CREATED_AND_LINKED",
        xeroContactLinked: true,
        subscriptionRefreshPending: true,
      }),
    );
    expect(JSON.stringify(body)).not.toContain("private cleanup detail");
  });

  it("does not claim subscription refresh pending after refresh succeeded", async () => {
    mockCreate.mockResolvedValue("contact-linked");
    mockLogAudit.mockRejectedValue(new Error("private audit detail"));

    const res = await POST(postReq(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(
      expect.objectContaining({
        code: "XERO_PARTIAL_SUCCESS",
        recoveryKind: "CONTACT_CREATED_AND_LINKED",
        xeroContactLinked: true,
      }),
    );
    expect(body).not.toHaveProperty("subscriptionRefreshPending");
    expect(JSON.stringify(body)).not.toContain("private audit detail");
  });
});
