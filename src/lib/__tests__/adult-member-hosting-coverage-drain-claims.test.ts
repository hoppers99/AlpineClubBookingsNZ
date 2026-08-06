import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  loadPolicy: vi.fn(),
  loadDependents: vi.fn(),
  reconcile: vi.fn(),
  claimNotification: vi.fn(),
  loadNotificationDelivery: vi.fn(),
  completeNotification: vi.fn(),
  releaseNotification: vi.fn(),
  resolveIncidents: vi.fn(),
  sendEmail: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/adult-member-hosting-coverage-queue", () => ({
  claimHostingCoverageReevaluations: mocks.claim,
  completeHostingCoverageReevaluation: mocks.complete,
  failHostingCoverageReevaluation: mocks.fail,
}));

vi.mock("@/lib/adult-member-hosting-coverage-incidents", () => ({
  claimHostingCoverageOwnerNotification: mocks.claimNotification,
  loadHostingCoverageOwnerNotificationDelivery: mocks.loadNotificationDelivery,
  completeHostingCoverageOwnerNotification: mocks.completeNotification,
  releaseHostingCoverageOwnerNotification: mocks.releaseNotification,
  resolveHostingCoverageIncidents: mocks.resolveIncidents,
}));

vi.mock("@/lib/adult-member-hosting-review", () => ({
  loadAdultMemberHostingPolicy: mocks.loadPolicy,
  loadSameOwnerCoverageDependentIds: mocks.loadDependents,
  reconcileSameOwnerCoverageIncident: mocks.reconcile,
}));

vi.mock("@/lib/email/booking", () => ({
  sendHostingCoverageLostEmail: mocks.sendEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: mocks.warn, error: mocks.error },
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { drainHostingCoverageReevaluations } from "@/lib/adult-member-hosting-coverage-drain";

const CLAIMED_ITEM = {
  id: "queue-1",
  memberId: "owner-1",
  lodgeId: "lodge-a",
  nights: ["2026-07-03"],
  cause: "SYSTEM_CHANGE" as const,
  sourceBookingId: null,
  actorMemberId: null,
  reason: null,
  attempts: 1,
  claimToken: "claim-current",
};

const DELIVERY = {
  bookingId: "booking-1",
  recipientMemberId: "owner-1",
  email: "owner@example.test",
  firstName: "Owner",
  checkIn: new Date("2026-07-03T00:00:00.000Z"),
  checkOut: new Date("2026-07-04T00:00:00.000Z"),
  lodgeId: "lodge-a",
  uncoveredNights: "2026-07-03",
};

function makeDb() {
  return {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({}),
    ),
  } as any;
}

describe("hosting coverage drain claim fences (#2596)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockReset();
    mocks.claim.mockResolvedValueOnce([{ ...CLAIMED_ITEM }]).mockResolvedValue([]);
    mocks.complete.mockResolvedValue(true);
    mocks.fail.mockResolvedValue(true);
    mocks.loadPolicy.mockResolvedValue({
      hostScopes: { sameBookingOwner: true },
    });
    mocks.loadDependents.mockResolvedValue([]);
    mocks.resolveIncidents.mockResolvedValue(0);
    mocks.loadNotificationDelivery.mockResolvedValue({ ...DELIVERY });
    mocks.completeNotification.mockResolvedValue(true);
    mocks.releaseNotification.mockResolvedValue(true);
  });

  it("does not count work as processed when completion loses the exact claim", async () => {
    mocks.complete.mockResolvedValue(false);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 0 });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "queue-1", claimToken: "claim-current" }),
      expect.anything(),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "queue-1" }),
      expect.stringContaining("claim was replaced"),
    );
  });

  it("does not attribute a failure to a worker after its claim was replaced", async () => {
    mocks.loadPolicy.mockRejectedValue(new Error("reconciliation failed"));
    mocks.fail.mockResolvedValue(false);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 0 });
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "queue-1", claimToken: "claim-current" }),
      "reconciliation failed",
      expect.anything(),
    );
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "queue-1" }),
      expect.stringContaining("claim was replaced"),
    );
  });

  it.each([
    ["resolved incident", null],
    ["replaced state or token", null],
    ["expired notification lease", null],
  ])("calls no provider for a stale %s claim", async (_label, delivery) => {
    mocks.loadDependents.mockResolvedValue(["booking-1"]);
    mocks.reconcile.mockResolvedValue({
      action: "opened",
      incidentId: "incident-1",
      stateKey: "v1:state-a",
    });
    mocks.claimNotification.mockResolvedValue({
      incidentId: "incident-1",
      stateKey: "v1:state-a",
      claimToken: "notification-current",
    });
    mocks.loadNotificationDelivery.mockResolvedValue(delivery);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 1, notified: 0, failed: 0 });
    expect(mocks.loadNotificationDelivery).toHaveBeenCalledWith(
      {
        bookingId: "booking-1",
        incidentId: "incident-1",
        stateKey: "v1:state-a",
        claimToken: "notification-current",
      },
      expect.anything(),
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.completeNotification).not.toHaveBeenCalled();
    expect(mocks.releaseNotification).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "notification-current" }),
      expect.anything(),
    );
  });

  it("fails and releases the exact claims when the No-emails flag is unreadable", async () => {
    mocks.loadDependents.mockResolvedValue(["booking-1"]);
    mocks.reconcile.mockResolvedValue({
      action: "opened",
      incidentId: "incident-1",
      stateKey: "v1:state-a",
    });
    mocks.claimNotification.mockResolvedValue({
      incidentId: "incident-1",
      stateKey: "v1:state-a",
      claimToken: "notification-current",
    });
    mocks.sendEmail.mockResolvedValue({
      status: "withheld_for_booking",
      emailLogId: "mail-1",
      bookingId: "booking-1",
      reason: "booking_flag_unreadable",
    });

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 0, notified: 0, failed: 1 });
    expect(mocks.releaseNotification).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "notification-current" }),
      expect.anything(),
    );
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "queue-1", claimToken: "claim-current" }),
      expect.stringContaining("could not be read"),
      expect.anything(),
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["missing email", { ...DELIVERY, email: "" }, undefined],
    [
      "intentional No-emails suppression",
      DELIVERY,
      {
        status: "withheld_for_booking",
        emailLogId: "mail-1",
        bookingId: "booking-1",
        reason: "booking_no_emails",
      },
    ],
    [
      "recipient suppression",
      DELIVERY,
      {
        status: "suppressed",
        emailLogId: "mail-1",
        emailSuppressionId: "suppression-1",
        reason: "BOUNCE",
      },
    ],
  ])("keeps %s terminal while leaving the officer incident open", async (_label, delivery, emailOutcome) => {
    mocks.loadDependents.mockResolvedValue(["booking-1"]);
    mocks.reconcile.mockResolvedValue({
      action: "opened",
      incidentId: "incident-1",
      stateKey: "v1:state-a",
    });
    mocks.claimNotification.mockResolvedValue({
      incidentId: "incident-1",
      stateKey: "v1:state-a",
      claimToken: "notification-current",
    });
    mocks.loadNotificationDelivery.mockResolvedValue(delivery);
    if (emailOutcome) mocks.sendEmail.mockResolvedValue(emailOutcome);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 1, notified: 0, failed: 0 });
    expect(mocks.releaseNotification).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "notification-current" }),
      expect.anything(),
    );
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("claims serial work just in time instead of pre-leasing later rows", async () => {
    const later = {
      ...CLAIMED_ITEM,
      id: "queue-2",
      claimToken: "claim-later",
    };
    mocks.claim.mockReset();
    mocks.claim
      .mockResolvedValueOnce([{ ...CLAIMED_ITEM }])
      .mockResolvedValueOnce([later])
      .mockResolvedValue([]);

    const result = await drainHostingCoverageReevaluations({ limit: 2 }, makeDb());

    expect(result).toMatchObject({ claimed: 2, processed: 2, failed: 0 });
    expect(mocks.claim).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ limit: 1, excludeIds: [] }),
      expect.anything(),
    );
    expect(mocks.claim).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 1, excludeIds: ["queue-1"] }),
      expect.anything(),
    );
    expect(mocks.claim.mock.invocationCallOrder[1]).toBeGreaterThan(
      mocks.complete.mock.invocationCallOrder[0],
    );
  });

  it("excludes a released failure so one drain cannot burn it again", async () => {
    mocks.loadPolicy.mockRejectedValue(new Error("temporary failure"));

    const result = await drainHostingCoverageReevaluations({ limit: 5 }, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 1 });
    expect(mocks.claim).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 1, excludeIds: ["queue-1"] }),
      expect.anything(),
    );
    expect(mocks.fail).toHaveBeenCalledTimes(1);
  });
});
