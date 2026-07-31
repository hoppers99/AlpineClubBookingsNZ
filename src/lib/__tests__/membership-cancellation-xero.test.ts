import { beforeEach, describe, expect, it, vi } from "vitest";
import { Contact } from "xero-node";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberSubscriptionFindUnique: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  xeroSyncOperationFindFirst: vi.fn(),
  callXeroApi: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  refreshXeroContactCachesFromContact: vi.fn(),
  loadMembershipCancellationSettings: vi.fn(),
  getManagedGroupUniverse: vi.fn(),
  buildXeroPayloadHash: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  getInvoice: vi.fn(),
  createCreditNotes: vi.fn(),
  createCreditNoteAllocation: vi.fn(),
  getContact: vi.fn(),
  deleteContactGroupContact: vi.fn(),
  createContactGroupContacts: vi.fn(),
  updateContact: vi.fn(),
  sendAdminXeroSyncErrorAlert: vi.fn().mockResolvedValue(undefined),
  // #2392 (review NEW-1): the archive re-asks the unpaid-invoice question live,
  // immediately before it archives. Default: nothing owing.
  loadInvoiceBlockers: vi.fn(),
  // #2400: who else the subscription invoice still covers. Default: nobody, so
  // the leaver is the last one out and the invoice is credited in full.
  findOtherLiveMembersCovered: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
    },
    memberSubscription: {
      findUnique: mocks.memberSubscriptionFindUnique,
    },
    xeroObjectLink: {
      findFirst: mocks.xeroObjectLinkFindFirst,
    },
    xeroSyncOperation: {
      update: mocks.xeroSyncOperationUpdate,
      findFirst: mocks.xeroSyncOperationFindFirst,
    },
  },
}));

vi.mock("@/lib/xero", () => ({
  callXeroApi: mocks.callXeroApi,
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  refreshXeroContactCachesFromContact: mocks.refreshXeroContactCachesFromContact,
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: Array<string | number | boolean | null | undefined>) =>
    parts
      .filter((part): part is string | number | boolean => part !== null && part !== undefined && part !== "")
      .map((part) => String(part))
      .join(":"),
  buildXeroPayloadHash: mocks.buildXeroPayloadHash,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

vi.mock("@/lib/membership-cancellation-settings", () => ({
  loadMembershipCancellationSettings: mocks.loadMembershipCancellationSettings,
}));

vi.mock("@/lib/membership-cancellation-invoice-blockers", () => ({
  loadMembershipCancellationInvoiceBlockersByMemberId: mocks.loadInvoiceBlockers,
}));

vi.mock("@/lib/membership-cancellation-subscription-credit", () => ({
  findOtherLiveMembersCoveredBySubscriptionInvoice:
    mocks.findOtherLiveMembersCovered,
}));

vi.mock("@/lib/xero-member-grouping", () => ({
  getManagedGroupUniverse: mocks.getManagedGroupUniverse,
}));

vi.mock("@/lib/email", () => ({
  sendAdminXeroSyncErrorAlert: mocks.sendAdminXeroSyncErrorAlert,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  createXeroMembershipCancellationCreditNote,
  syncXeroMembershipCancellationContact,
} from "@/lib/membership-cancellation-xero";

function xeroClient() {
  return {
    accountingApi: {
      getInvoice: mocks.getInvoice,
      createCreditNotes: mocks.createCreditNotes,
      createCreditNoteAllocation: mocks.createCreditNoteAllocation,
      getContact: mocks.getContact,
      deleteContactGroupContact: mocks.deleteContactGroupContact,
      createContactGroupContacts: mocks.createContactGroupContacts,
      updateContact: mocks.updateContact,
    },
  };
}

describe("membership cancellation Xero operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callXeroApi.mockImplementation(async (runner: () => unknown) => runner());
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: xeroClient(),
      tenantId: "tenant_1",
    });
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "206",
      itemCode: "CANCEL-CREDIT",
      codeExplicitlyConfigured: true,
    });
    mocks.buildXeroPayloadHash.mockReturnValue("payload_hash");
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "alloc_op_1" });
    mocks.completeXeroSyncOperation.mockResolvedValue({});
    mocks.upsertXeroObjectLink.mockResolvedValue({});
    mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
    mocks.xeroSyncOperationUpdate.mockResolvedValue({});
    // Default: the cancellation credit note has already settled, so the contact
    // archive guard lets archiving proceed. Tests override this to exercise the
    // deferral path.
    mocks.xeroSyncOperationFindFirst.mockResolvedValue({ status: "SUCCEEDED" });
    mocks.failXeroSyncOperation.mockResolvedValue({});
    mocks.refreshXeroContactCachesFromContact.mockResolvedValue(undefined);
    mocks.loadInvoiceBlockers.mockImplementation(
      async (memberIds: readonly string[]) =>
        new Map(memberIds.map((memberId) => [memberId, []])),
    );
    mocks.findOtherLiveMembersCovered.mockResolvedValue([]);
  });

  it("creates and allocates a subscription cancellation credit note using the membership cancellation mapping", async () => {
    mocks.memberSubscriptionFindUnique.mockResolvedValue({
      id: "sub_1",
      memberId: "member_1",
      seasonYear: 2026,
      status: "UNPAID",
      xeroInvoiceId: "inv_sub_1",
      member: {
        id: "member_1",
        firstName: "Alice",
        lastName: "Smith",
        xeroContactId: "contact_1",
      },
    });
    mocks.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv_sub_1",
            invoiceNumber: "INV-1",
            amountDue: 123.45,
            contact: { contactID: "contact_1" },
          },
        ],
      },
    });
    mocks.createCreditNotes.mockResolvedValue({
      body: {
        creditNotes: [{ creditNoteID: "cn_1", creditNoteNumber: "CN-1" }],
      },
    });
    mocks.createCreditNoteAllocation.mockResolvedValue({
      body: { allocations: [{ amount: 123.45 }] },
    });

    await expect(
      createXeroMembershipCancellationCreditNote({
        subscriptionId: "sub_1",
        requestId: "request_1",
        participantId: "participant_1",
        createdByMemberId: "admin_1",
        syncOperationId: "op_1",
      }),
    ).resolves.toBe("cn_1");

    const creditNoteRequest = mocks.createCreditNotes.mock.calls[0][1];
    const lineItem = creditNoteRequest.creditNotes[0].lineItems[0];
    expect(lineItem).toEqual(
      expect.objectContaining({
        accountCode: "206",
        itemCode: "CANCEL-CREDIT",
        quantity: 1,
        unitAmount: 123.45,
      }),
    );
    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledWith(
      "tenant_1",
      "cn_1",
      {
        allocations: [
          {
            invoice: { invoiceID: "inv_sub_1" },
            amount: 123.45,
            date: expect.any(String),
          },
        ],
      },
      undefined,
      "credit-note:cn_1:membership-cancellation:invoice:inv_sub_1:12345:v1",
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_1",
        extraLinks: expect.arrayContaining([
          expect.objectContaining({
            localModel: "MemberSubscription",
            localId: "sub_1",
            role: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          }),
          expect.objectContaining({
            localModel: "MembershipCancellationRequestParticipant",
            localId: "participant_1",
          }),
          expect.objectContaining({
            localModel: "MembershipCancellationRequest",
            localId: "request_1",
          }),
        ]),
      }),
    );
  });

  it("alerts admins instead of silently skipping when a paid subscription is cancelled", async () => {
    mocks.memberSubscriptionFindUnique.mockResolvedValue({
      id: "sub_1",
      memberId: "member_1",
      seasonYear: 2026,
      status: "PAID",
      xeroInvoiceId: "inv_sub_1",
      member: {
        id: "member_1",
        firstName: "Alice",
        lastName: "Smith",
        xeroContactId: "contact_1",
      },
    });

    await expect(
      createXeroMembershipCancellationCreditNote({
        subscriptionId: "sub_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      }),
    ).resolves.toBeNull();

    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "membership_cancellation_paid_subscription_no_refund",
        operation: "createXeroMembershipCancellationCreditNote",
      }),
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          skipped: true,
          reason: "paid_subscription_no_refund",
          status: "PAID",
          adminAlertSent: true,
        }),
      }),
    );
  });

  // #2400: a family is billed with ONE invoice covering everyone in it, and the
  // credit note below is for that invoice's WHOLE remaining balance.
  describe("shared family invoices", () => {
    function unpaidFamilySubscription() {
      mocks.memberSubscriptionFindUnique.mockResolvedValue({
        id: "sub_1",
        memberId: "member_1",
        seasonYear: 2026,
        status: "UNPAID",
        xeroInvoiceId: "inv_family",
        xeroInvoiceNumber: "INV-0042",
        member: {
          id: "member_1",
          firstName: "Ada",
          lastName: "Smith",
          xeroContactId: "contact_1",
        },
      });
      mocks.getInvoice.mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_family",
              invoiceNumber: "INV-0042",
              amountDue: 300,
              contact: { contactID: "contact_1" },
            },
          ],
        },
      });
      mocks.createCreditNotes.mockResolvedValue({
        body: { creditNotes: [{ creditNoteID: "cn_1", creditNoteNumber: "CN-1" }] },
      });
      mocks.createCreditNoteAllocation.mockResolvedValue({
        body: { allocations: [{ amount: 300 }] },
      });
    }

    it("credits the invoice's whole remaining balance when the leaver is the last member it covers", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");

      expect(mocks.findOtherLiveMembersCovered).toHaveBeenCalledWith({
        invoiceId: "inv_family",
        leavingMemberId: "member_1",
      });
      expect(
        mocks.createCreditNotes.mock.calls[0][1].creditNotes[0].lineItems[0]
          .unitAmount,
      ).toBe(300);
      expect(mocks.createCreditNoteAllocation).toHaveBeenCalledWith(
        "tenant_1",
        "cn_1",
        { allocations: [{ invoice: { invoiceID: "inv_family" }, amount: 300, date: expect.any(String) }] },
        undefined,
        expect.any(String),
      );
    });

    it("raises nothing at all while the invoice still covers a member who is staying", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([
        { memberId: "member_2", name: "Bob Smith" },
      ]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBeNull();

      expect(mocks.createCreditNotes).not.toHaveBeenCalled();
      expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
      // The whole answer is local, so the skip does not even authenticate.
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      expect(mocks.getInvoice).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_1",
        expect.objectContaining({
          responsePayload: expect.objectContaining({
            skipped: true,
            reason: "shared_invoice_covers_remaining_members",
            invoiceId: "inv_family",
            sharedWith: [{ memberId: "member_2", name: "Bob Smith" }],
          }),
        }),
      );
    });

    it("skips again on a re-run rather than drifting into a credit note", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([
        { memberId: "member_2", name: "Bob Smith" },
      ]);

      for (const _run of [1, 2, 3]) {
        await expect(
          createXeroMembershipCancellationCreditNote({
            subscriptionId: "sub_1",
            requestId: "request_1",
            participantId: "participant_1",
            syncOperationId: "op_1",
          }),
        ).resolves.toBeNull();
      }

      expect(mocks.createCreditNotes).not.toHaveBeenCalled();
      expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    });

    it("credits in full on the retry that follows the rest of the family being cancelled", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValueOnce([
        { memberId: "member_2", name: "Bob Smith" },
      ]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBeNull();

      // Bob has since been cancelled, so the same operation retried now finds
      // nobody left and credits the invoice in full.
      mocks.findOtherLiveMembersCovered.mockResolvedValue([]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");

      expect(mocks.createCreditNotes).toHaveBeenCalledTimes(1);
      expect(
        mocks.createCreditNotes.mock.calls[0][1].creditNotes[0].lineItems[0]
          .unitAmount,
      ).toBe(300);
    });

    it("finishes allocating a credit note that already exists, whoever the invoice now covers", async () => {
      unpaidFamilySubscription();
      // A previous run created the note; only the allocation is outstanding.
      mocks.xeroObjectLinkFindFirst
        .mockResolvedValueOnce({
          xeroObjectId: "cn_existing",
          xeroObjectNumber: "CN-9",
          xeroObjectUrl: "https://xero/cn_existing",
        })
        .mockResolvedValueOnce(null);
      mocks.findOtherLiveMembersCovered.mockResolvedValue([
        { memberId: "member_2", name: "Bob Smith" },
      ]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_existing");

      // The money is already credited in Xero — abandoning it unallocated would
      // be worse than finishing the job, so the shared check is not consulted.
      expect(mocks.findOtherLiveMembersCovered).not.toHaveBeenCalled();
      expect(mocks.createCreditNoteAllocation).toHaveBeenCalledWith(
        "tenant_1",
        "cn_existing",
        { allocations: [{ invoice: { invoiceID: "inv_family" }, amount: 300, date: expect.any(String) }] },
        undefined,
        expect.any(String),
      );
    });
  });

  it("removes managed age-tier groups, adds cancelled groups, and archives the Xero contact", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Alice",
      lastName: "Smith",
      ageTier: "ADULT",
      xeroContactId: "contact_1",
    });
    mocks.loadMembershipCancellationSettings.mockResolvedValue({
      warningText: "",
      rejoinProcessText: "",
      xeroArchiveContactsOnCancellation: true,
      xeroContactGroups: [{ groupId: "cancelled_group", groupName: "Cancelled" }],
    });
    mocks.getManagedGroupUniverse.mockResolvedValue(["adult_group", "youth_group"]);
    mocks.getContact
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              contactStatus: Contact.ContactStatusEnum.ACTIVE,
              contactGroups: [
                { contactGroupID: "adult_group", name: "Adults" },
                { contactGroupID: "other_group", name: "Other" },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              contactStatus: Contact.ContactStatusEnum.ARCHIVED,
              contactGroups: [{ contactGroupID: "cancelled_group", name: "Cancelled" }],
            },
          ],
        },
      });
    mocks.deleteContactGroupContact.mockResolvedValue({});
    mocks.createContactGroupContacts.mockResolvedValue({});
    mocks.updateContact.mockResolvedValue({ body: { contacts: [{ contactID: "contact_1" }] } });

    await expect(
      syncXeroMembershipCancellationContact({
        memberId: "member_1",
        requestId: "request_1",
        participantId: "participant_1",
        createdByMemberId: "admin_1",
        syncOperationId: "op_1",
      }),
    ).resolves.toEqual({
      memberId: "member_1",
      xeroContactId: "contact_1",
      addedGroupIds: ["cancelled_group"],
      removedGroupIds: ["adult_group"],
      archived: true,
      skippedReason: null,
    });

    expect(mocks.deleteContactGroupContact).toHaveBeenCalledWith(
      "tenant_1",
      "adult_group",
      "contact_1",
    );
    expect(mocks.createContactGroupContacts).toHaveBeenCalledWith(
      "tenant_1",
      "cancelled_group",
      { contacts: [{ contactID: "contact_1" }] },
      "contact:contact_1:cancelled-contact-group-add:cancelled_group:v1",
    );
    expect(mocks.updateContact).toHaveBeenCalledWith(
      "tenant_1",
      "contact_1",
      {
        contacts: [
          {
            contactID: "contact_1",
            contactStatus: Contact.ContactStatusEnum.ARCHIVED,
          },
        ],
      },
      "contact:contact_1:membership-cancellation-archive:participant_1:v1",
    );
  });

  it("defers archiving the Xero contact until the cancellation credit note has settled", async () => {
    // The credit note's outbox operation is still pending, so archiving now
    // would block it. The contact operation must fail (for retry) and leave the
    // contact untouched rather than archive prematurely.
    mocks.xeroSyncOperationFindFirst.mockResolvedValue({ status: "PENDING" });
    mocks.memberFindUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Alice",
      lastName: "Smith",
      ageTier: "ADULT",
      xeroContactId: "contact_1",
    });
    mocks.loadMembershipCancellationSettings.mockResolvedValue({
      warningText: "",
      rejoinProcessText: "",
      xeroArchiveContactsOnCancellation: true,
      xeroContactGroups: [{ groupId: "cancelled_group", groupName: "Cancelled" }],
    });
    mocks.getManagedGroupUniverse.mockResolvedValue(["adult_group"]);
    mocks.getContact.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_1",
            contactStatus: Contact.ContactStatusEnum.ACTIVE,
            contactGroups: [{ contactGroupID: "adult_group", name: "Adults" }],
          },
        ],
      },
    });

    await expect(
      syncXeroMembershipCancellationContact({
        memberId: "member_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      }),
    ).rejects.toThrow(/credit note/i);

    // No contact mutation while deferring: no archive, no group changes.
    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(mocks.deleteContactGroupContact).not.toHaveBeenCalled();
    expect(mocks.createContactGroupContacts).not.toHaveBeenCalled();
    // Operation is failed so it is retried after the credit note posts.
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.any(Error),
    );
  });

  // #2392 (review NEW-1): the approval-time gate cannot be the last word,
  // because this operation runs off the outbox later — a cancellation approved
  // while archiving was OFF (so no check ever ran) archives here the moment an
  // admin switches archiving on.
  describe("the archive re-checks the money before it runs", () => {
    function readyToArchive() {
      mocks.memberFindUnique.mockResolvedValue({
        id: "member_1",
        firstName: "Alice",
        lastName: "Smith",
        ageTier: "ADULT",
        xeroContactId: "contact_1",
      });
      mocks.loadMembershipCancellationSettings.mockResolvedValue({
        warningText: "",
        rejoinProcessText: "",
        xeroArchiveContactsOnCancellation: true,
        xeroContactGroups: [],
      });
      mocks.getManagedGroupUniverse.mockResolvedValue([]);
      mocks.getContact.mockResolvedValue({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              contactStatus: Contact.ContactStatusEnum.ACTIVE,
              contactGroups: [],
            },
          ],
        },
      });
      mocks.updateContact.mockResolvedValue({ body: { contacts: [] } });
    }

    it("asks live, not from the review queue's memo", async () => {
      readyToArchive();

      await syncXeroMembershipCancellationContact({
        memberId: "member_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      });

      expect(mocks.loadInvoiceBlockers).toHaveBeenCalledWith(["member_1"], {
        fresh: true,
      });
      expect(mocks.updateContact).toHaveBeenCalled();
    });

    it("defers the archive while the contact still has money owing", async () => {
      readyToArchive();
      mocks.loadInvoiceBlockers.mockResolvedValue(
        new Map([
          [
            "member_1",
            [
              {
                type: "unpaid_invoice",
                invoiceId: "inv-1",
                invoiceNumber: "INV-0042",
                invoiceStatus: "AUTHORISED",
                direction: "receivable",
                amountDueCents: 12050,
                currency: "NZD",
                dueDate: "2026-06-30",
                xeroUrl: null,
                xeroContactUrl: null,
              },
            ],
          ],
        ]),
      );

      await expect(
        syncXeroMembershipCancellationContact({
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).rejects.toThrow(/INV-0042/);

      // Nothing is archived, and the operation is failed so it retries once the
      // invoice is paid, credited or voided — rather than being abandoned.
      expect(mocks.updateContact).not.toHaveBeenCalled();
      expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
        "op_1",
        expect.any(Error),
      );
    });

    it("defers the archive when the check itself could not run", async () => {
      readyToArchive();
      mocks.loadInvoiceBlockers.mockResolvedValue(
        new Map([
          [
            "member_1",
            [{ type: "invoice_check_unavailable", reason: "disconnected" }],
          ],
        ]),
      );

      await expect(
        syncXeroMembershipCancellationContact({
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).rejects.toThrow(/Xero is not connected/);

      expect(mocks.updateContact).not.toHaveBeenCalled();
    });

    it("does not ask when this operation is not archiving anything", async () => {
      readyToArchive();
      mocks.loadMembershipCancellationSettings.mockResolvedValue({
        warningText: "",
        rejoinProcessText: "",
        xeroArchiveContactsOnCancellation: false,
        xeroContactGroups: [],
      });

      await syncXeroMembershipCancellationContact({
        memberId: "member_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      });

      expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
      expect(mocks.updateContact).not.toHaveBeenCalled();
    });
  });

  it("is idempotent when cancellation contact groups and archive status are already applied", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Alice",
      lastName: "Smith",
      ageTier: "ADULT",
      xeroContactId: "contact_1",
    });
    mocks.loadMembershipCancellationSettings.mockResolvedValue({
      warningText: "",
      rejoinProcessText: "",
      xeroArchiveContactsOnCancellation: true,
      xeroContactGroups: [{ groupId: "cancelled_group", groupName: "Cancelled" }],
    });
    mocks.getManagedGroupUniverse.mockResolvedValue(["adult_group"]);
    mocks.getContact.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_1",
            contactStatus: Contact.ContactStatusEnum.ARCHIVED,
            contactGroups: [{ contactGroupID: "cancelled_group", name: "Cancelled" }],
          },
        ],
      },
    });

    await expect(
      syncXeroMembershipCancellationContact({
        memberId: "member_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      }),
    ).resolves.toEqual({
      memberId: "member_1",
      xeroContactId: "contact_1",
      addedGroupIds: [],
      removedGroupIds: [],
      archived: false,
      skippedReason: null,
    });

    expect(mocks.deleteContactGroupContact).not.toHaveBeenCalled();
    expect(mocks.createContactGroupContacts).not.toHaveBeenCalled();
    expect(mocks.updateContact).not.toHaveBeenCalled();
  });
});
