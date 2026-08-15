import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    member: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    xeroSyncOperation: {
      findFirst: vi.fn(),
      // #2623 T7: the phase-2 link transaction closes any provider-created
      // recovery whose own contact is the one it just linked.
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    // #1355: contact resolution reads the member on the GLOBAL client
    // (phase 0/1) and re-reads via the tx client (phase 2). Alias the same
    // mock fns so every existing fixture serves both phases.
    member: tx.member,
    xeroToken: {
      findFirst: vi.fn(),
    },
  };

  const xeroClientInstance = {
    initialize: vi.fn().mockResolvedValue(undefined),
    setTokenSet: vi.fn(),
    refreshWithRefreshToken: vi.fn(),
    accountingApi: {
      createContacts: vi.fn(),
      getContacts: vi.fn(),
    },
  };

  return {
    prisma,
    tx,
    xeroClientInstance,
    XeroClient: vi.fn(function MockXeroClient() {
      return xeroClientInstance;
    }),
    upsertXeroObjectLink: vi.fn(),
    startXeroSyncOperation: vi.fn(),
    completeXeroSyncOperation: vi.fn(),
    failXeroSyncOperation: vi.fn(),
    assertMemberAvailableForXeroContactChange: vi.fn(),
    lockMemberForXeroContactLink: vi.fn(
      async (db: typeof tx, memberId: string) =>
        db.member.findUnique({ where: { id: memberId } }),
    ),
    recordProviderCreatedContactPendingLocalLink: vi.fn(),
    recordXeroApiUsage: vi.fn(),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock("xero-node", () => ({
  XeroClient: mocks.XeroClient,
  Contact: class {},
  ContactGroup: class {},
  Invoice: {
    TypeEnum: { ACCREC: "ACCREC" },
    StatusEnum: { AUTHORISED: "AUTHORISED" },
  },
  LineItem: class {},
  LineAmountTypes: { Inclusive: "Inclusive" },
  CreditNote: {
    TypeEnum: { ACCRECCREDIT: "ACCRECCREDIT" },
    StatusEnum: { AUTHORISED: "AUTHORISED" },
  },
  Payment: class {},
  Phone: {
    PhoneTypeEnum: { MOBILE: "MOBILE" },
  },
  Address: {
    AddressTypeEnum: {
      STREET: "STREET",
      POBOX: "POBOX",
    },
  },
}));

vi.mock(
  "@/lib/xero-contact-create-recovery",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/xero-contact-create-recovery")
    >()),
    assertMemberAvailableForXeroContactChange:
      mocks.assertMemberAvailableForXeroContactChange,
    lockMemberForXeroContactLink: mocks.lockMemberForXeroContactLink,
    recordProviderCreatedContactPendingLocalLink:
      mocks.recordProviderCreatedContactPendingLocalLink,
  }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock("@/lib/pricing", () => ({
  getSeasonYear: vi.fn(),
  getStayNights: vi.fn(),
}));

vi.mock("@/lib/phone", () => ({
  formatXeroPhone: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: mocks.logger,
}));

vi.mock("@/lib/xero-api-usage", () => ({
  recordXeroApiUsage: mocks.recordXeroApiUsage,
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: vi.fn((contactId: string) => `https://go.xero.test/contact/${contactId}`),
  buildXeroInvoiceUrl: vi.fn((invoiceId: string) => `https://go.xero.test/invoice/${invoiceId}`),
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();

  return {
    ...actual,
    buildXeroIdempotencyKey: vi.fn((...parts: unknown[]) => parts.join(":")),
    buildXeroPayloadHash: vi.fn(() => "payload-hash"),
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
  };
});

// DB-only Xero resolution (#2079): supply the operational config and the
// token-encryption key from a stub so the token round-trip below needs no
// integration-credential DB rows.
vi.mock("@/lib/xero-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-config")>();
  return {
    ...actual,
    getOperationalXeroConfig: vi.fn().mockResolvedValue({
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUris: ["https://example.com/api/admin/xero/callback"],
      scopes: [...actual.XERO_REQUIRED_REPORT_OAUTH_SCOPES],
      httpTimeout: 10_000,
    }),
    getOperationalXeroEncryptionKey: vi
      .fn()
      .mockResolvedValue(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
  };
});

import {
  encryptToken,
  findOrCreateXeroContact,
  resetXeroRateLimitStateForTests,
} from "@/lib/xero";

describe("findOrCreateXeroContact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    vi.stubEnv(
      "XERO_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );

    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.$executeRaw.mockResolvedValue(undefined);
    mocks.tx.$queryRaw.mockImplementation(
      async (_strings: TemplateStringsArray, memberId: string) => [{ id: memberId }],
    );
    mocks.tx.member.findFirst.mockResolvedValue(null);
    mocks.tx.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.tx.xeroSyncOperation.findMany.mockResolvedValue([]);
    mocks.tx.xeroSyncOperation.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.member.update.mockResolvedValue({ id: "mem_1", xeroContactId: "xero_new" });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.recordProviderCreatedContactPendingLocalLink.mockResolvedValue(undefined);
    mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
      body: { contacts: [] },
    });
  });

  it("trusts an existing member.xeroContactId without verifying it via Xero", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_existing",
    });

    await expect(findOrCreateXeroContact("mem_1")).resolves.toBe("xero_existing");

    expect(mocks.prisma.xeroToken.findFirst).not.toHaveBeenCalled();
    expect(mocks.xeroClientInstance.accountingApi.getContacts).not.toHaveBeenCalled();
    expect(mocks.tx.member.update).not.toHaveBeenCalled();
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      {
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_existing",
        xeroObjectUrl: "https://go.xero.test/contact/xero_existing",
        role: "CONTACT",
      },
      { store: mocks.tx },
    );
  });

  it("can explicitly repair an existing link by re-searching Xero and updating the member link", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_stale",
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: await encryptToken("access"),
      refreshToken: await encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [{ contactID: "xero_repaired" }],
      },
    });

    await expect(
      findOrCreateXeroContact("mem_1", { repairExistingLink: true })
    ).resolves.toBe("xero_repaired");

    expect(mocks.xeroClientInstance.accountingApi.getContacts).toHaveBeenCalledWith(
      "tenant_1",
      undefined,
      'EmailAddress="member@example.com"'
    );
    expect(mocks.tx.member.update).toHaveBeenCalledWith({
      where: { id: "mem_1" },
      data: { xeroContactId: "xero_repaired" },
    });
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      {
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_repaired",
        xeroObjectUrl: "https://go.xero.test/contact/xero_repaired",
        role: "CONTACT",
        metadata: {
          contactName: undefined,
          linkedVia: "email_match_repair",
          repairedFromXeroContactId: "xero_stale",
        },
      },
      { store: mocks.tx },
    );
  });

  it("skips the Xero email search for a walk-in placeholder owner and sends an empty email (#1935)", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_walkin",
      firstName: "Walk",
      lastName: "In",
      email: "walk-in-abc123@no-email.invalid",
      xeroContactId: null,
      phoneNumber: null,
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: await encryptToken("access"),
      refreshToken: await encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.tx.member.update.mockResolvedValue({ id: "mem_walkin", xeroContactId: "xero_walkin" });
    mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "xero_walkin" }] },
    });

    await expect(findOrCreateXeroContact("mem_walkin")).resolves.toBe("xero_walkin");

    // The placeholder must never be used to search Xero (it could otherwise
    // match a real contact) and must never be sent as a real address.
    expect(mocks.xeroClientInstance.accountingApi.getContacts).not.toHaveBeenCalled();
    const createPayload =
      mocks.xeroClientInstance.accountingApi.createContacts.mock.calls[0][1];
    expect(createPayload.contacts[0].emailAddress).toBe("");
  });

  // #2859. The create branch records `linkedVia: "created"` as a POSITIVE fact,
  // and `updateXeroContact` reads it as the one case where it may write the
  // member's date of birth into the NZBN field without first observing what
  // that field holds. Without the marker, a default install (grouping mode
  // NONE, the schema default, so nothing ever writes a contact-cache row) would
  // send the date of birth at contact-create time and never again.
  //
  // It must be POSITIVE. The absence of `linkedVia` cannot stand in for it:
  // `xero-member-import.ts` links members onto pre-existing Xero contacts by
  // setting `xeroContactId` directly with no link metadata at all, which is how
  // essentially the whole live membership got its contacts, and reading that as
  // "we created it" would hand those contacts' real business numbers to the
  // birthday writer.
  it("records that THIS APP created a contact it created", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_walkin",
      firstName: "Walk",
      lastName: "In",
      email: "walk-in-abc123@no-email.invalid",
      xeroContactId: null,
      phoneNumber: null,
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: await encryptToken("access"),
      refreshToken: await encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.tx.member.update.mockResolvedValue({
      id: "mem_walkin",
      xeroContactId: "xero_walkin",
    });
    mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "xero_walkin" }] },
    });

    await expect(findOrCreateXeroContact("mem_walkin")).resolves.toBe(
      "xero_walkin",
    );

    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      {
        localModel: "Member",
        localId: "mem_walkin",
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_walkin",
        xeroObjectUrl: "https://go.xero.test/contact/xero_walkin",
        role: "CONTACT",
        metadata: { linkedVia: "created" },
      },
      { store: mocks.tx },
    );
  });

  // #2623 T2. A walk-in placeholder owner is the DETERMINISTIC case: the Xero
  // email search is skipped by design, so nothing can produce a matched-existing
  // resolution, and the repair therefore reaches the create reservation on every
  // single attempt. That reservation used to throw XERO_CONTACT_ALREADY_LINKED
  // unconditionally whenever the member had a link, so Admin → Force sync →
  // Contact 409'd forever with nothing able to clear it.
  describe("repairing an existing link (#2623 T2)", () => {
    const walkInOwner = {
      id: "mem_walkin",
      firstName: "Walk",
      lastName: "In",
      email: "walk-in-abc123@no-email.invalid",
      xeroContactId: "xero_stale_walkin",
      phoneNumber: null,
    };

    async function connectXero() {
      mocks.prisma.xeroToken.findFirst.mockResolvedValue({
        id: "token_1",
        accessToken: await encryptToken("access"),
        refreshToken: await encryptToken("refresh"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        tenantId: "tenant_1",
      });
    }

    it("repairs a walk-in placeholder owner's link instead of 409ing forever", async () => {
      mocks.tx.member.findUnique.mockResolvedValue(walkInOwner);
      await connectXero();
      // No live contact carries this member's name, so creation is the honest
      // outcome and the reservation must be allowed to make it.
      mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
        body: { contacts: [] },
      });
      mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
        body: { contacts: [{ contactID: "xero_repaired_walkin" }] },
      });

      await expect(
        findOrCreateXeroContact("mem_walkin", { repairExistingLink: true }),
      ).resolves.toBe("xero_repaired_walkin");

      // The placeholder is still never used to search Xero by email.
      for (const call of mocks.xeroClientInstance.accountingApi.getContacts.mock
        .calls) {
        expect(String(call[2] ?? "")).not.toContain("EmailAddress");
      }
      expect(mocks.tx.member.update).toHaveBeenCalledWith({
        where: { id: "mem_walkin" },
        data: { xeroContactId: "xero_repaired_walkin" },
      });
      expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
    });

    it("re-links a live same-named contact rather than minting a duplicate", async () => {
      mocks.tx.member.findUnique.mockResolvedValue(walkInOwner);
      await connectXero();
      mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
        body: {
          contacts: [{ contactID: "xero_live_walkin", name: "Walk In" }],
        },
      });

      await expect(
        findOrCreateXeroContact("mem_walkin", { repairExistingLink: true }),
      ).resolves.toBe("xero_live_walkin");

      // Archived contacts are excluded from that search, so a genuinely dead
      // link still falls through to creation (previous test) — but a live one
      // must never become a second contact in the club's books.
      expect(
        mocks.xeroClientInstance.accountingApi.getContacts,
      ).toHaveBeenCalledWith(
        "tenant_1",
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        false,
        true,
        "Walk In",
        20,
      );
      expect(
        mocks.xeroClientInstance.accountingApi.createContacts,
      ).not.toHaveBeenCalled();
      expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
      expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
        expect.objectContaining({
          xeroObjectId: "xero_live_walkin",
          metadata: expect.objectContaining({
            linkedVia: "name_match_repair",
            repairedFromXeroContactId: "xero_stale_walkin",
          }),
        }),
        { store: mocks.tx },
      );
    });

    it("still refuses a create reservation for an already-linked member with no repair intent", async () => {
      mocks.tx.member.findUnique.mockResolvedValue({
        ...walkInOwner,
        xeroContactId: null,
      });
      await connectXero();
      mocks.xeroClientInstance.accountingApi.createContacts.mockResolvedValue({
        body: { contacts: [{ contactID: "xero_first" }] },
      });
      // The reservation re-reads the member under its own KEY SHARE lock: a
      // link that appeared in between must still refuse an ordinary create.
      mocks.tx.member.findUnique
        .mockResolvedValueOnce({ ...walkInOwner, xeroContactId: null })
        .mockResolvedValue(walkInOwner);

      await expect(findOrCreateXeroContact("mem_walkin")).rejects.toMatchObject({
        code: "XERO_CONTACT_ALREADY_LINKED",
      });
      expect(
        mocks.xeroClientInstance.accountingApi.createContacts,
      ).not.toHaveBeenCalled();
    });
  });

  it("links an exact Xero name match when createContacts fails with a duplicate-name validation error", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      firstName: "Jordan",
      lastName: "Hartley-Smith",
      email: "test.contact@example.org",
      xeroContactId: null,
      dateOfBirth: new Date("1987-08-30T00:00:00.000Z"),
      phoneCountryCode: "64",
      phoneAreaCode: "",
      phoneNumber: "274224115",
      streetAddressLine1: "165 Barrett Road",
      streetAddressLine2: "",
      streetCity: "New Plymouth",
      streetRegion: "Taranaki",
      streetPostalCode: "4310",
      streetCountry: "NZ",
      postalAddressLine1: "165 Barrett Road",
      postalAddressLine2: "",
      postalCity: "New Plymouth",
      postalRegion: "Taranaki",
      postalPostalCode: "4310",
      postalCountry: "NZ",
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: await encryptToken("access"),
      refreshToken: await encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.xeroClientInstance.accountingApi.getContacts
      .mockResolvedValueOnce({ body: { contacts: [] } })
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "xero_existing_by_name",
              name: "Jordan Hartley-Smith",
              firstName: "Jordan",
              lastName: "Hartley-Smith",
            },
          ],
        },
      });
    mocks.xeroClientInstance.accountingApi.createContacts.mockRejectedValue({
      response: { statusCode: 400 },
      message: JSON.stringify({
        response: {
          statusCode: 400,
        },
        body: {
          Message: "A validation exception occurred",
          Elements: [
            {
              ValidationErrors: [
                {
                  Message:
                    "The contact name Jordan Hartley-Smith is already assigned to another contact. The contact name must be unique across all active contacts.",
                },
              ],
            },
          ],
        },
      }),
    });

    await expect(findOrCreateXeroContact("mem_1")).resolves.toBe(
      "xero_existing_by_name"
    );

    expect(mocks.xeroClientInstance.accountingApi.getContacts).toHaveBeenNthCalledWith(
      1,
      "tenant_1",
      undefined,
      'EmailAddress="test.contact@example.org"'
    );
    expect(mocks.xeroClientInstance.accountingApi.getContacts).toHaveBeenNthCalledWith(
      2,
      "tenant_1",
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      false,
      true,
      "Jordan Hartley-Smith",
      20
    );
    const createPayload =
      mocks.xeroClientInstance.accountingApi.createContacts.mock.calls[0][1];
    // #2859: the create payload now carries the member's date of birth in the
    // NZBN field. This line asserted its ABSENCE before #2859, which was the
    // defect rather than the contract.
    expect(createPayload.contacts[0].companyNumber).toBe("30/08/1987");
    expect(mocks.tx.member.update).toHaveBeenCalledWith({
      where: { id: "mem_1" },
      data: { xeroContactId: "xero_existing_by_name" },
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_existing_by_name",
        responsePayload: expect.objectContaining({
          resolution: "linked_existing_contact_by_name",
          matchedBy: "name",
        }),
      })
    );
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      {
        localModel: "Member",
        localId: "mem_1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "xero_existing_by_name",
        xeroObjectUrl: "https://go.xero.test/contact/xero_existing_by_name",
        role: "CONTACT",
        metadata: {
          linkedVia: "name_match",
          contactName: "Jordan Hartley-Smith",
          repairedFromXeroContactId: undefined,
        },
      },
      { store: mocks.tx },
    );
  });
});
