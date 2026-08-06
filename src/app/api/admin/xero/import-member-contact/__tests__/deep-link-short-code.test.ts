import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2314, the one place the two link rules meet in a single handler.
 *
 * Importing a Xero contact as a member writes a `XeroObjectLink` row AND hands
 * the admin a link to click. The owner's decision makes those deliberately
 * different: what is STORED stays organisation-agnostic (a short code baked into
 * a row is wrong the moment the club reconnects to a different Xero
 * organisation, and the row outlives the request), while what is RETURNED is
 * scoped now, so the click lands in this club's books.
 *
 * Before #2314 both were the same short-code-less string, so a regression that
 * collapses them back together is exactly what this pins.
 */

const ORG_SHORT_CODE = "!aBc12";
const CONTACT_ID = "xero-contact-1";

const mocks = vi.hoisted(() => ({
  getXeroOrgShortCode: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  memberFindFirst: vi.fn(),
  memberCreate: vi.fn(),
  getContact: vi.fn(),
  refreshXeroContactCachesFromContact: vi.fn(),
  syncMemberSubscriptionHistoryForLinkedContact: vi.fn(),
  ensureMemberAccessRolesFromCompatibilityFields: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("bcryptjs", () => ({ hash: async () => "hashed" }));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => ({
    ok: true as const,
    session: { user: { id: "admin-1" } },
  }),
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: mocks.memberFindFirst, create: mocks.memberCreate },
  },
}));

vi.mock("@/lib/member-access-role-writes", () => ({
  ensureMemberAccessRolesFromCompatibilityFields:
    mocks.ensureMemberAccessRolesFromCompatibilityFields,
}));

vi.mock("@/lib/xero-link-short-code", () => ({
  getXeroOrgShortCode: mocks.getXeroOrgShortCode,
}));

vi.mock("@/lib/xero-sync", () => ({
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

// No live provider: the Xero client is a stub throughout.
vi.mock("@/lib/xero", () => ({
  getAuthenticatedXeroClient: async () => ({
    xero: { accountingApi: { getContact: mocks.getContact } },
    tenantId: "tenant-1",
  }),
  callXeroApi: async (fn: () => Promise<unknown>) => fn(),
  refreshXeroContactCachesFromContact:
    mocks.refreshXeroContactCachesFromContact,
  syncMemberSubscriptionHistoryForLinkedContact:
    mocks.syncMemberSubscriptionHistoryForLinkedContact,
}));

vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: (_err: unknown, message: string) => ({
    handled: false,
    status: 500,
    clientMessage: message,
    diagnosticMessage: message,
  }),
}));

import { POST } from "@/app/api/admin/xero/import-member-contact/route";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";
import { buildXeroContactUrl } from "@/lib/xero-links";

function request() {
  return new NextRequest(
    "http://localhost/api/admin/xero/import-member-contact",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: CONTACT_ID }),
    },
  );
}

describe("POST /api/admin/xero/import-member-contact deep links (#2314)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getXeroOrgShortCode.mockResolvedValue(ORG_SHORT_CODE);
    mocks.getContact.mockResolvedValue({
      body: { contacts: [{ contactID: CONTACT_ID, name: "Riley Chen" }] },
    });
    mocks.refreshXeroContactCachesFromContact.mockResolvedValue({
      cachedContact: {
        contactId: CONTACT_ID,
        name: "Riley Chen",
        firstName: "Riley",
        lastName: "Chen",
        emailAddress: "riley@example.org",
      },
    });
    mocks.memberFindFirst.mockResolvedValue(null);
    mocks.memberCreate.mockResolvedValue({
      id: "mem_1",
      firstName: "Riley",
      lastName: "Chen",
      email: "riley@example.org",
      active: true,
      xeroContactId: CONTACT_ID,
    });
    mocks.syncMemberSubscriptionHistoryForLinkedContact.mockResolvedValue({
      errors: [],
    });
  });

  it("returns an organisation-scoped link but stores a generic one", async () => {
    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.xeroLink).toBe(
      buildXeroContactUrl(CONTACT_ID, { shortCode: ORG_SHORT_CODE }),
    );
    expect(body.xeroLink).toContain(`shortcode=${ORG_SHORT_CODE}`);

    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        xeroObjectUrl: buildXeroContactUrl(CONTACT_ID),
      }),
    );
    // The stored URL names no organisation at all — that is what survives a
    // reconnect to a different Xero organisation.
    expect(
      mocks.upsertXeroObjectLink.mock.calls[0][0].xeroObjectUrl,
    ).not.toContain("shortcode");
  });

  it("degrades the returned link when no short code is available", async () => {
    mocks.getXeroOrgShortCode.mockResolvedValue(null);

    const body = await (await POST(request())).json();

    // Still a live link, just not organisation-scoped.
    expect(body.xeroLink).toBe(buildXeroContactUrl(CONTACT_ID));
    expect(
      mocks.upsertXeroObjectLink.mock.calls[0][0].xeroObjectUrl,
    ).toBe(buildXeroContactUrl(CONTACT_ID));
  });

  it("keeps ordinary subscription refresh failures as a successful import warning", async () => {
    mocks.syncMemberSubscriptionHistoryForLinkedContact.mockRejectedValueOnce(
      new Error("Xero history unavailable"),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.memberId).toBe("mem_1");
    expect(body.warning).toMatch(/subscription history refresh did not complete/i);
  });

  it("returns the fixed 409 with truthful partial-import metadata on participant contention", async () => {
    mocks.syncMemberSubscriptionHistoryForLinkedContact.mockRejectedValueOnce(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      memberImported: true,
      memberId: "mem_1",
      xeroContactLinked: true,
      subscriptionRefreshPending: true,
    });
  });
});
