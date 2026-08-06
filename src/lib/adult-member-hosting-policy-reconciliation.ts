import type { PrismaClient } from "@prisma/client";

import { enqueueHostingCoverageReevaluation } from "@/lib/adult-member-hosting-coverage-queue";
import { eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";
import {
  resolveAdultMemberHostingPolicy,
  type ResolvedAdultMemberHostingPolicy,
} from "@/lib/policies/adult-member-hosting";

/**
 * The persisted policy columns needed to compare the effective rule before and
 * after a policy-set mutation. Keep this projection independent of revision and
 * capacity: neither changes whether an existing urgent coverage incident is a
 * valid instrument.
 */
export const HOSTING_POLICY_RECONCILIATION_SELECT = {
  id: true,
  scopeKey: true,
  lodgeId: true,
  mode: true,
  capacityMode: true,
  version: true,
  hostScopeSameBooking: true,
  hostScopeSameBookingOwner: true,
} as const;

export type HostingPolicyReconciliationSnapshot = {
  id: string;
  scopeKey: string;
  lodgeId: string | null;
  mode: "INHERIT" | "DISABLED" | "ADMIN_REVIEW_REQUIRED" | "ENFORCED";
  capacityMode: "HOLD" | "NO_HOLD";
  version: number;
  hostScopeSameBooking: boolean | null;
  hostScopeSameBookingOwner: boolean | null;
};

type HostingPolicyReconciliationDb = Pick<
  PrismaClient,
  | "adultMemberHostingPolicy"
  | "hostingCoverageIncident"
  | "hostingCoverageReevaluation"
>;

function incidentMaterialPolicy(
  rows: readonly HostingPolicyReconciliationSnapshot[],
  lodgeId: string,
): Pick<ResolvedAdultMemberHostingPolicy, "mode" | "hostScopes"> {
  const resolved = resolveAdultMemberHostingPolicy(rows, lodgeId);
  return { mode: resolved.mode, hostScopes: resolved.hostScopes };
}

function incidentPolicyChanged(
  beforeRows: readonly HostingPolicyReconciliationSnapshot[],
  afterRows: readonly HostingPolicyReconciliationSnapshot[],
  lodgeId: string,
): boolean {
  const before = incidentMaterialPolicy(beforeRows, lodgeId);
  const after = incidentMaterialPolicy(afterRows, lodgeId);
  return (
    before.mode !== after.mode ||
    before.hostScopes.sameBooking !== after.hostScopes.sameBooking ||
    before.hostScopes.sameBookingOwner !== after.hostScopes.sameBookingOwner
  );
}

/**
 * Durably schedule every currently-active incident whose effective enforcement
 * mode or host-scope set changed in the policy mutation that just ran.
 *
 * This runs INSIDE the authoritative policy transaction, after its writes. Each
 * queue item still names exactly one booking owner, one lodge and that booking's
 * explicit lodge nights; policy administration never introduces a lodge-wide
 * work item. The post-commit drain then re-reads current facts and either closes
 * the now-inapplicable incident or refreshes it under the new scope set.
 *
 * Reading all active incidents is intentional: a club-wide row can affect some
 * lodges through mode inheritance and a different set through host-scope
 * inheritance. Resolving before/after per incident lodge is both complete and
 * narrower than guessing from the row that was edited.
 */
export async function enqueueActiveHostingIncidentPolicyReconciliation(
  params: {
    beforePolicies: readonly HostingPolicyReconciliationSnapshot[];
    actorMemberId?: string | null;
  },
  db: HostingPolicyReconciliationDb,
): Promise<number> {
  const afterPolicies = (await db.adultMemberHostingPolicy.findMany({
    select: HOSTING_POLICY_RECONCILIATION_SELECT,
  })) as HostingPolicyReconciliationSnapshot[];

  const activeIncidents = await db.hostingCoverageIncident.findMany({
    where: { resolvedAt: null },
    orderBy: [{ openedAt: "asc" }, { id: "asc" }],
    select: {
      booking: {
        select: {
          id: true,
          memberId: true,
          lodgeId: true,
          checkIn: true,
          checkOut: true,
        },
      },
    },
  });

  const changedByLodge = new Map<string, boolean>();
  let queued = 0;
  for (const incident of activeIncidents) {
    const booking = incident.booking;
    let affected = changedByLodge.get(booking.lodgeId);
    if (affected === undefined) {
      affected = incidentPolicyChanged(
        params.beforePolicies,
        afterPolicies,
        booking.lodgeId,
      );
      changedByLodge.set(booking.lodgeId, affected);
    }
    if (!affected) continue;

    const id = await enqueueHostingCoverageReevaluation(
      {
        memberId: booking.memberId,
        lodgeId: booking.lodgeId,
        nights: eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(
          formatDateOnly,
        ),
        cause: "SYSTEM_CHANGE",
        sourceBookingId: booking.id,
        actorMemberId: params.actorMemberId ?? null,
      },
      db,
    );
    if (id !== null) queued += 1;
  }
  return queued;
}
