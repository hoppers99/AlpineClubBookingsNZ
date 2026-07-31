import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  memberSubscriptionFindMany: vi.fn(),
  chargeCoverageFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: mocks.memberFindMany },
    memberSubscription: { findMany: mocks.memberSubscriptionFindMany },
    membershipSubscriptionChargeCoverage: {
      findMany: mocks.chargeCoverageFindMany,
    },
  },
}));

import {
  findOtherLiveMembersCoveredBySubscriptionInvoice,
  loadLiveMembersCoveredBySubscriptionInvoices,
  loadMembershipCancellationSharedInvoiceNoticesByMemberId,
  loadMembershipCancellationSubscriptionCreditPlansByMemberId,
} from "@/lib/membership-cancellation-subscription-credit";
import { getSeasonYear } from "@/lib/utils";

const NOW_MS = Date.UTC(2026, 6, 31, 3, 0, 0);
const SEASON = getSeasonYear(new Date(NOW_MS));

type SubscriptionRow = {
  id?: string;
  memberId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber?: string | null;
  seasonRow?: boolean;
};

/**
 * `memberSubscription.findMany` is asked two different questions by this module
 * — "whose season subscription would be credited" (season-scoped) and "who is
 * this invoice linked to" (invoice-scoped) — so the fake answers on the shape of
 * the `where`, exactly as the database would.
 */
function respondWithSubscriptions(input: {
  season?: SubscriptionRow[];
  linkedToInvoice?: SubscriptionRow[];
}) {
  mocks.memberSubscriptionFindMany.mockImplementation(
    async (args: { where?: Record<string, unknown> }) => {
      const isSeasonQuery = args?.where?.seasonYear !== undefined;
      return isSeasonQuery
        ? (input.season ?? [])
        : (input.linkedToInvoice ?? []);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWithSubscriptions({});
  mocks.chargeCoverageFindMany.mockResolvedValue([]);
  mocks.memberFindMany.mockResolvedValue([]);
});

describe("who a subscription invoice still covers", () => {
  it("names every live member the invoice is linked to", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      {
        id: "member_1",
        firstName: "Ada",
        lastName: "Smith",
        cancelledAt: null,
      },
      {
        id: "member_2",
        firstName: "Bob",
        lastName: "Smith",
        cancelledAt: null,
      },
    ]);

    const covered = await loadLiveMembersCoveredBySubscriptionInvoices([
      "inv_1",
    ]);

    expect(covered.get("inv_1")).toEqual([
      { memberId: "member_1", name: "Ada Smith" },
      { memberId: "member_2", name: "Bob Smith" },
    ]);
  });

  it("counts a member held only by an active charge-coverage claim", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [{ memberId: "member_1", xeroInvoiceId: "inv_1" }],
    });
    // The subscription link was lost (legacy row, or a partial void release) but
    // the claim still says this member's season is billed on that charge.
    mocks.chargeCoverageFindMany.mockResolvedValue([
      { memberId: "member_2", charge: { xeroInvoiceId: "inv_1" } },
    ]);
    mocks.memberFindMany.mockResolvedValue([
      { id: "member_1", firstName: "Ada", lastName: "Smith", cancelledAt: null },
      { id: "member_2", firstName: "Bob", lastName: "Smith", cancelledAt: null },
    ]);

    const covered = await loadLiveMembersCoveredBySubscriptionInvoices([
      "inv_1",
    ]);

    expect(covered.get("inv_1")).toEqual([
      { memberId: "member_1", name: "Ada Smith" },
      { memberId: "member_2", name: "Bob Smith" },
    ]);
    expect(mocks.chargeCoverageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ releasedAt: null }),
      }),
    );
  });

  it("does not let a member who has themselves been cancelled keep the invoice alive", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      { id: "member_1", firstName: "Ada", lastName: "Smith", cancelledAt: null },
      {
        id: "member_2",
        firstName: "Bob",
        lastName: "Smith",
        cancelledAt: new Date(NOW_MS),
      },
    ]);

    const covered = await loadLiveMembersCoveredBySubscriptionInvoices([
      "inv_1",
    ]);

    expect(covered.get("inv_1")).toEqual([
      { memberId: "member_1", name: "Ada Smith" },
    ]);
  });

  it("still counts a deactivated member who has not been cancelled", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [{ memberId: "member_2", xeroInvoiceId: "inv_1" }],
    });
    // active:false with no cancelledAt is "inactive", not "cancelled" — their
    // season is still billed on this invoice, so the money is still owed.
    mocks.memberFindMany.mockResolvedValue([
      {
        id: "member_2",
        firstName: "Bob",
        lastName: "Smith",
        cancelledAt: null,
        active: false,
      },
    ]);

    const covered = await loadLiveMembersCoveredBySubscriptionInvoices([
      "inv_1",
    ]);

    expect(covered.get("inv_1")).toEqual([
      { memberId: "member_2", name: "Bob Smith" },
    ]);
  });

  it("returns an entry for every invoice asked about, so no key never reads as nobody", async () => {
    const covered = await loadLiveMembersCoveredBySubscriptionInvoices([
      "inv_1",
      "inv_2",
    ]);

    expect([...covered.keys()].sort()).toEqual(["inv_1", "inv_2"]);
    expect(covered.get("inv_1")).toEqual([]);
    expect(covered.get("inv_2")).toEqual([]);
  });

  it("reads nothing at all when there are no invoices to ask about", async () => {
    const covered = await loadLiveMembersCoveredBySubscriptionInvoices([]);

    expect(covered.size).toBe(0);
    expect(mocks.memberSubscriptionFindMany).not.toHaveBeenCalled();
    expect(mocks.chargeCoverageFindMany).not.toHaveBeenCalled();
  });
});

describe("the members other than the leaver", () => {
  it("is empty for a one-member family, so the invoice is credited in full", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [{ memberId: "member_1", xeroInvoiceId: "inv_1" }],
    });
    mocks.memberFindMany.mockResolvedValue([
      { id: "member_1", firstName: "Ada", lastName: "Smith", cancelledAt: null },
    ]);

    await expect(
      findOtherLiveMembersCoveredBySubscriptionInvoice({
        invoiceId: "inv_1",
        leavingMemberId: "member_1",
      }),
    ).resolves.toEqual([]);
  });

  it("names the family members who are staying", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
        { memberId: "member_3", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      { id: "member_1", firstName: "Ada", lastName: "Smith", cancelledAt: null },
      { id: "member_2", firstName: "Bob", lastName: "Smith", cancelledAt: null },
      { id: "member_3", firstName: "Cy", lastName: "Smith", cancelledAt: null },
    ]);

    await expect(
      findOtherLiveMembersCoveredBySubscriptionInvoice({
        invoiceId: "inv_1",
        leavingMemberId: "member_2",
      }),
    ).resolves.toEqual([
      { memberId: "member_1", name: "Ada Smith" },
      { memberId: "member_3", name: "Cy Smith" },
    ]);
  });

  it("is empty once the rest of the family has already been cancelled", async () => {
    respondWithSubscriptions({
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      {
        id: "member_1",
        firstName: "Ada",
        lastName: "Smith",
        cancelledAt: new Date(NOW_MS),
      },
      { id: "member_2", firstName: "Bob", lastName: "Smith", cancelledAt: null },
    ]);

    await expect(
      findOtherLiveMembersCoveredBySubscriptionInvoice({
        invoiceId: "inv_1",
        leavingMemberId: "member_2",
      }),
    ).resolves.toEqual([]);
  });
});

describe("the credit plan a cancellation would carry out", () => {
  it("credits in full when the leaver is the last one covered", async () => {
    respondWithSubscriptions({
      season: [
        {
          id: "sub_1",
          memberId: "member_1",
          xeroInvoiceId: "inv_1",
          xeroInvoiceNumber: "INV-0042",
        },
      ],
      linkedToInvoice: [{ memberId: "member_1", xeroInvoiceId: "inv_1" }],
    });
    mocks.memberFindMany.mockResolvedValue([
      { id: "member_1", firstName: "Ada", lastName: "Smith", cancelledAt: null },
    ]);

    const plans =
      await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
        ["member_1"],
        { nowMs: NOW_MS },
      );

    expect(plans.get("member_1")).toEqual({
      subscriptionId: "sub_1",
      invoiceId: "inv_1",
      invoiceNumber: "INV-0042",
      xeroUrl: expect.stringContaining("inv_1"),
      sharedWith: [],
      creditsInFull: true,
    });
    expect(mocks.memberSubscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          seasonYear: SEASON,
          status: { in: ["UNPAID", "OVERDUE"] },
        }),
      }),
    );
  });

  it("credits nothing when the invoice still covers a member who is staying", async () => {
    respondWithSubscriptions({
      season: [
        {
          id: "sub_1",
          memberId: "member_1",
          xeroInvoiceId: "inv_1",
          xeroInvoiceNumber: "INV-0042",
        },
      ],
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      { id: "member_1", firstName: "Ada", lastName: "Smith", cancelledAt: null },
      { id: "member_2", firstName: "Bob", lastName: "Smith", cancelledAt: null },
    ]);

    const plans =
      await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
        ["member_1"],
        { nowMs: NOW_MS },
      );

    expect(plans.get("member_1")).toMatchObject({
      creditsInFull: false,
      sharedWith: [{ memberId: "member_2", name: "Bob Smith" }],
    });
  });

  it("has no plan for a member with nothing creditable", async () => {
    const plans =
      await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
        ["member_1"],
        { nowMs: NOW_MS },
      );

    expect(plans.get("member_1")).toBeNull();
    expect(plans.has("member_1")).toBe(true);
  });
});

describe("the review queue's shared-invoice notice", () => {
  it("is raised only where nothing will be credited", async () => {
    respondWithSubscriptions({
      season: [
        {
          id: "sub_1",
          memberId: "member_1",
          xeroInvoiceId: "inv_1",
          xeroInvoiceNumber: "INV-0042",
        },
        {
          id: "sub_9",
          memberId: "member_9",
          xeroInvoiceId: "inv_9",
          xeroInvoiceNumber: "INV-0099",
        },
      ],
      linkedToInvoice: [
        { memberId: "member_1", xeroInvoiceId: "inv_1" },
        { memberId: "member_2", xeroInvoiceId: "inv_1" },
        { memberId: "member_9", xeroInvoiceId: "inv_9" },
      ],
    });
    mocks.memberFindMany.mockResolvedValue([
      { id: "member_1", firstName: "Ada", lastName: "Smith", cancelledAt: null },
      { id: "member_2", firstName: "Bob", lastName: "Smith", cancelledAt: null },
      { id: "member_9", firstName: "Zoe", lastName: "Jones", cancelledAt: null },
    ]);

    const notices =
      await loadMembershipCancellationSharedInvoiceNoticesByMemberId(
        ["member_1", "member_9"],
        { nowMs: NOW_MS },
      );

    expect(notices.get("member_1")).toEqual({
      invoiceId: "inv_1",
      invoiceNumber: "INV-0042",
      xeroUrl: expect.stringContaining("inv_1"),
      sharedWith: [{ memberId: "member_2", name: "Bob Smith" }],
    });
    // Sole covered member: the credit happens, so there is nothing to warn about.
    expect(notices.get("member_9")).toBeNull();
  });
});
