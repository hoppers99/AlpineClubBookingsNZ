import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  defer: vi.fn(),
  fail: vi.fn(),
  loadClaimed: vi.fn(),
  renew: vi.fn(),
  lockPolicySet: vi.fn(),
  lockMember: vi.fn(),
  loadPolicy: vi.fn(),
  sourceBookingIsTerminal: vi.fn(),
  loadDependents: vi.fn(),
  reconcile: vi.fn(),
  claimNotification: vi.fn(),
  loadNotificationDelivery: vi.fn(),
  completeNotification: vi.fn(),
  pendingNotification: vi.fn(),
  releaseNotification: vi.fn(),
  resolveIncidents: vi.fn(),
  sendEmail: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/adult-member-hosting-coverage-queue", () => ({
  claimHostingCoverageReevaluations: mocks.claim,
  completeHostingCoverageReevaluation: mocks.complete,
  deferHostingCoverageReevaluation: mocks.defer,
  failHostingCoverageReevaluation: mocks.fail,
  loadClaimedHostingCoverageReevaluation: mocks.loadClaimed,
  renewHostingCoverageReevaluationClaim: mocks.renew,
}));

vi.mock("@/lib/adult-member-hosting-policy-set", () => ({
  lockAdultMemberHostingPolicySet: mocks.lockPolicySet,
}));

vi.mock("@/lib/adult-member-hosting-coverage-incidents", () => ({
  claimHostingCoverageOwnerNotification: mocks.claimNotification,
  isHostingCoverageOwnerNotificationPending: mocks.pendingNotification,
  loadHostingCoverageOwnerNotificationDelivery: mocks.loadNotificationDelivery,
  completeHostingCoverageOwnerNotification: mocks.completeNotification,
  releaseHostingCoverageOwnerNotification: mocks.releaseNotification,
  resolveHostingCoverageIncidents: mocks.resolveIncidents,
}));

vi.mock("@/lib/adult-member-hosting-review", () => ({
  isHostingCoverageSourceBookingTerminal: mocks.sourceBookingIsTerminal,
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
  const tx = { $executeRaw: mocks.lockMember };
  return {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
  } as any;
}

describe("hosting coverage drain claim fences (#2596)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockReset();
    mocks.claim.mockResolvedValueOnce([{ ...CLAIMED_ITEM }]).mockResolvedValue([]);
    mocks.complete.mockResolvedValue(true);
    mocks.defer.mockResolvedValue(true);
    mocks.fail.mockResolvedValue(true);
    mocks.loadClaimed.mockResolvedValue({ ...CLAIMED_ITEM });
    mocks.lockPolicySet.mockResolvedValue(undefined);
    mocks.lockMember.mockResolvedValue(1);
    mocks.renew.mockResolvedValue(true);
    mocks.loadPolicy.mockResolvedValue({
      hostScopes: { sameBookingOwner: true },
    });
    mocks.sourceBookingIsTerminal.mockResolvedValue(false);
    mocks.loadDependents.mockResolvedValue([]);
    mocks.resolveIncidents.mockResolvedValue(0);
    mocks.loadNotificationDelivery.mockResolvedValue({ ...DELIVERY });
    mocks.completeNotification.mockResolvedValue(true);
    mocks.pendingNotification.mockResolvedValue(false);
    mocks.releaseNotification.mockResolvedValue(true);
  });

  it("stabilises through chained merges before using refreshed owner and actor", async () => {
    const claimed = {
      ...CLAIMED_ITEM,
      memberId: "owner-loser",
      actorMemberId: "actor-loser",
      lodgeId: "lodge-before",
      nights: ["2026-07-01"],
      sourceBookingId: "source-before",
      reason: "stale reason",
    };
    const firstMerge = {
      ...claimed,
      memberId: "owner-master-1",
      actorMemberId: "actor-master-1",
      lodgeId: "lodge-after",
      nights: ["2026-07-03", "2026-07-04"],
      cause: "OFFICER_OVERRIDE" as const,
      sourceBookingId: "source-after",
      reason: "authoritative reason",
    };
    const stable = {
      ...firstMerge,
      memberId: "owner-master-2",
      actorMemberId: "actor-master-2",
    };
    mocks.claim.mockReset();
    mocks.claim.mockResolvedValueOnce([claimed]).mockResolvedValue([]);
    mocks.lockMember.mockResolvedValue(0);
    mocks.loadClaimed
      .mockResolvedValueOnce(firstMerge)
      .mockResolvedValue(stable);
    mocks.loadDependents.mockResolvedValue(["dependent-after"]);
    mocks.reconcile.mockResolvedValue({ action: "none" });

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 1, incidentsResolved: 0 });
    expect(mocks.lockMember.mock.calls.map((call) => call[1])).toEqual([
      "member-lifecycle:actor-loser",
      "member-lifecycle:owner-loser",
      "actor-loser",
      "owner-loser",
      "member-lifecycle:actor-master-1",
      "member-lifecycle:owner-master-1",
      "actor-master-1",
      "owner-master-1",
      "member-lifecycle:actor-master-2",
      "member-lifecycle:owner-master-2",
      "actor-master-2",
      "owner-master-2",
    ]);
    expect(mocks.lockPolicySet.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.lockMember.mock.invocationCallOrder[0],
    );
    expect(mocks.lockMember.mock.invocationCallOrder[3]).toBeLessThan(
      mocks.loadClaimed.mock.invocationCallOrder[0],
    );
    expect(mocks.loadPolicy).toHaveBeenCalledWith("lodge-after", expect.anything());
    expect(mocks.loadDependents).toHaveBeenCalledWith(
      {
        memberId: "owner-master-2",
        lodgeId: "lodge-after",
        nights: ["2026-07-03", "2026-07-04"],
      },
      expect.anything(),
    );
    expect(mocks.reconcile).toHaveBeenCalledWith(
      {
        bookingId: "dependent-after",
        cause: "OFFICER_OVERRIDE",
        actorMemberId: "actor-master-2",
        reason: "authoritative reason",
      },
      expect.anything(),
    );
    expect(mocks.sourceBookingIsTerminal).toHaveBeenCalledWith(
      "source-after",
      expect.anything(),
    );
    expect(mocks.resolveIncidents).not.toHaveBeenCalled();
  });

  it("resolves a directly verified terminal source even when the bounded list omits it", async () => {
    const item = {
      ...CLAIMED_ITEM,
      sourceBookingId: "source-cancelled",
      actorMemberId: "officer-1",
    };
    mocks.claim.mockReset();
    mocks.claim.mockResolvedValueOnce([item]).mockResolvedValue([]);
    mocks.loadClaimed.mockResolvedValue(item);
    mocks.loadPolicy.mockResolvedValue({
      hostScopes: { sameBookingOwner: false },
    });
    mocks.sourceBookingIsTerminal.mockResolvedValue(true);
    mocks.resolveIncidents.mockResolvedValue(1);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 1, incidentsResolved: 1 });
    expect(mocks.resolveIncidents).toHaveBeenCalledWith(
      {
        bookingId: "source-cancelled",
        resolution: "BOOKING_CANCELLED",
        actorMemberId: "officer-1",
      },
      expect.anything(),
    );
    expect(mocks.loadDependents).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("does not resolve an active source merely because the capped dependent list omitted it", async () => {
    const item = { ...CLAIMED_ITEM, sourceBookingId: "source-after-cap" };
    mocks.claim.mockReset();
    mocks.claim.mockResolvedValueOnce([item]).mockResolvedValue([]);
    mocks.loadClaimed.mockResolvedValue(item);
    mocks.loadDependents.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => `dependent-${index + 1}`),
    );
    mocks.reconcile.mockResolvedValue({ action: "none" });
    mocks.sourceBookingIsTerminal.mockResolvedValue(false);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 1, incidentsResolved: 0 });
    expect(mocks.reconcile).toHaveBeenCalledTimes(25);
    expect(mocks.resolveIncidents).not.toHaveBeenCalled();
  });

  it("locks the sorted claimed identities before refresh when the drain wins", async () => {
    const claimed = {
      ...CLAIMED_ITEM,
      memberId: "member-z",
      actorMemberId: "member-a",
    };
    mocks.claim.mockReset();
    mocks.claim.mockResolvedValueOnce([claimed]).mockResolvedValue([]);
    mocks.loadClaimed.mockResolvedValue(claimed);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
    expect(mocks.lockMember.mock.calls.map((call) => call[1])).toEqual([
      "member-lifecycle:member-a",
      "member-lifecycle:member-z",
      "member-a",
      "member-z",
    ]);
    expect(mocks.loadDependents).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "member-z" }),
      expect.anything(),
    );
  });

  it("does no work when the exact claimed payload disappeared", async () => {
    mocks.loadClaimed.mockResolvedValue(null);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 0 });
    expect(mocks.loadPolicy).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("fails the exact claim when identities never stabilise", async () => {
    mocks.loadClaimed
      .mockResolvedValueOnce({
        ...CLAIMED_ITEM,
        memberId: "owner-2",
      })
      .mockResolvedValueOnce({
        ...CLAIMED_ITEM,
        memberId: "owner-3",
      })
      .mockResolvedValueOnce({
        ...CLAIMED_ITEM,
        memberId: "owner-4",
      });

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 1 });
    expect(mocks.loadClaimed).toHaveBeenCalledTimes(3);
    expect(mocks.loadPolicy).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "queue-1", claimToken: "claim-current" }),
      expect.stringContaining("did not stabilise"),
      expect.anything(),
    );
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

  it("rejects a replaced queue claimant before provider delivery and releases its notice", async () => {
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
    mocks.renew.mockResolvedValue(false);

    const result = await drainHostingCoverageReevaluations({}, makeDb());

    expect(result).toMatchObject({ claimed: 1, processed: 0, notified: 0, failed: 0 });
    expect(mocks.renew).toHaveBeenCalledWith(
      expect.objectContaining({ id: "queue-1", claimToken: "claim-current" }),
      expect.anything(),
    );
    expect(mocks.loadNotificationDelivery).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.releaseNotification).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "notification-current" }),
      expect.anything(),
    );
  });

  it("parks a successor behind a crashed sender without burning an attempt, then retries", async () => {
    mocks.loadDependents.mockResolvedValue(["booking-1"]);
    mocks.reconcile.mockResolvedValue({
      action: "unchanged",
      incidentId: "incident-1",
      stateKey: "v1:state-a",
    });
    mocks.claimNotification.mockResolvedValue(null);
    mocks.pendingNotification.mockResolvedValue(true);

    const successor = await drainHostingCoverageReevaluations({}, makeDb());

    expect(successor).toMatchObject({ claimed: 1, processed: 0, notified: 0, failed: 0 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.defer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "queue-1", claimToken: "claim-current" }),
      expect.anything(),
    );

    const retryItem = { ...CLAIMED_ITEM, claimToken: "claim-retry" };
    mocks.claim.mockReset();
    mocks.claim.mockResolvedValueOnce([retryItem]).mockResolvedValue([]);
    mocks.loadClaimed.mockResolvedValue(retryItem);
    mocks.claimNotification.mockResolvedValue({
      incidentId: "incident-1",
      stateKey: "v1:state-a",
      claimToken: "notification-retry",
    });
    mocks.pendingNotification.mockResolvedValue(false);
    mocks.sendEmail.mockResolvedValue({
      status: "sent",
      emailLogId: "mail-retry",
      bookingId: "booking-1",
      messageId: "provider-retry",
    });

    const retry = await drainHostingCoverageReevaluations({}, makeDb());

    expect(retry).toMatchObject({ claimed: 1, processed: 1, notified: 1, failed: 0 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.completeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "notification-retry" }),
      expect.anything(),
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "claim-retry" }),
      expect.anything(),
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
    ["superseded or already-notified state", null],
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
    mocks.releaseNotification.mockResolvedValue(false);
    mocks.pendingNotification.mockResolvedValue(false);

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
    expect(mocks.pendingNotification).toHaveBeenCalledWith(
      expect.objectContaining({ incidentId: "incident-1", stateKey: "v1:state-a" }),
      expect.anything(),
    );
  });

  it("defers when a null delivery proves its notification token was replaced, then retries", async () => {
    mocks.loadDependents.mockResolvedValue(["booking-1"]);
    mocks.reconcile.mockResolvedValue({
      action: "unchanged",
      incidentId: "incident-1",
      stateKey: "v1:state-a",
    });
    mocks.claimNotification.mockResolvedValue({
      incidentId: "incident-1",
      stateKey: "v1:state-a",
      claimToken: "notification-stale",
    });
    mocks.loadNotificationDelivery.mockResolvedValue(null);
    // Worker B replaced N while A still owns Q. A cannot release B's token, and
    // B then crashes before success-stamping the still-pending exact state.
    mocks.releaseNotification.mockResolvedValue(false);
    mocks.pendingNotification.mockResolvedValue(true);

    const stale = await drainHostingCoverageReevaluations({}, makeDb());

    expect(stale).toMatchObject({ claimed: 1, processed: 0, notified: 0, failed: 0 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.defer).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "claim-current" }),
      expect.anything(),
    );

    const retryItem = { ...CLAIMED_ITEM, claimToken: "claim-after-crash" };
    mocks.claim.mockReset();
    mocks.claim.mockResolvedValueOnce([retryItem]).mockResolvedValue([]);
    mocks.loadClaimed.mockResolvedValue(retryItem);
    mocks.claimNotification.mockResolvedValue({
      incidentId: "incident-1",
      stateKey: "v1:state-a",
      claimToken: "notification-after-crash",
    });
    mocks.loadNotificationDelivery.mockResolvedValue(DELIVERY);
    mocks.releaseNotification.mockResolvedValue(true);
    mocks.pendingNotification.mockResolvedValue(false);
    mocks.sendEmail.mockResolvedValue({
      status: "sent",
      emailLogId: "mail-after-crash",
      bookingId: "booking-1",
      messageId: "provider-after-crash",
    });

    const retry = await drainHostingCoverageReevaluations({}, makeDb());

    expect(retry).toMatchObject({ claimed: 1, processed: 1, notified: 1, failed: 0 });
    expect(mocks.completeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "notification-after-crash" }),
      expect.anything(),
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "claim-after-crash" }),
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
