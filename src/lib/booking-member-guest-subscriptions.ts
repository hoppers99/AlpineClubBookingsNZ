import type { AgeTier, SubscriptionStatus } from "@prisma/client";
import { getAgeTierSettings } from "@/lib/age-tier";
import { BookingGuestValidationError } from "@/lib/booking-guests";
import {
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_STATUS,
} from "@/lib/member-guest-refusal";
import {
  isSubscriptionEnforcementActive,
  requiresPaidSubscriptionForAgeTier,
} from "@/lib/member-subscription-eligibility";
import { resolveMembershipTypePoliciesForMembers } from "@/lib/membership-type-policy";
import { getSeasonYear } from "@/lib/utils";

interface BookingGuestLike {
  isMember: boolean;
  memberId?: string | null;
  /**
   * This guest is a member being added from beyond the booker's family group
   * ("+ Add Member Guest", epic #2305, MG2 #2307, owner decision **D-8**). Set by
   * the add paths; absent everywhere else, which is the pre-MG2 behaviour.
   */
  crossFamilyMemberGuest?: boolean | null;
}

interface BookingMemberGuestSubscriptionDb {
  memberSubscription: {
    findMany(args: {
      where: {
        memberId: { in: string[] };
        seasonYear: number;
      };
      select: {
        memberId: true;
        status: true;
        xeroOnlineInvoiceUrl: true;
        xeroInvoiceNumber: true;
      };
    }): Promise<
      Array<{
        memberId: string;
        status: SubscriptionStatus;
        xeroOnlineInvoiceUrl: string | null;
        xeroInvoiceNumber: string | null;
      }>
    >;
  };
  member: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; firstName: true; lastName: true; ageTier: true };
    }): Promise<
      Array<{ id: string; firstName: string; lastName: string; ageTier: AgeTier }>
    >;
  };
}

export interface UnpaidMemberGuestInfo {
  memberId: string;
  name: string;
  status: SubscriptionStatus;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
}

export async function findUnpaidMemberGuests(
  db: BookingMemberGuestSubscriptionDb,
  params: {
    bookingMemberId: string;
    checkIn: Date;
    guests: BookingGuestLike[];
  }
): Promise<UnpaidMemberGuestInfo[]> {
  const memberGuestIds = params.guests
    .filter(
      (guest) =>
        guest.isMember &&
        guest.memberId &&
        guest.memberId !== params.bookingMemberId
    )
    .map((guest) => guest.memberId as string);

  if (memberGuestIds.length === 0) {
    return [];
  }

  // With the Xero module effectively off, subscriptions cannot be invoiced or
  // paid, so member guests are never blocked on subscription status.
  if (!(await isSubscriptionEnforcementActive())) {
    return [];
  }

  const uniqueIds = [...new Set(memberGuestIds)];
  const seasonYear = getSeasonYear(params.checkIn);
  const ageTierSettings = await getAgeTierSettings();
  const subscriptions = await db.memberSubscription.findMany({
    where: {
      memberId: { in: uniqueIds },
      seasonYear,
    },
    select: {
      memberId: true,
      status: true,
      xeroOnlineInvoiceUrl: true,
      xeroInvoiceNumber: true,
    },
  });
  const membershipTypePolicies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: uniqueIds,
    seasonYear,
  });

  const subscriptionById = new Map(
    subscriptions.map((subscription) => [subscription.memberId, subscription])
  );
  const linkedMembers = await db.member.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, firstName: true, lastName: true, ageTier: true },
  });

  const memberById = new Map(linkedMembers.map((member) => [member.id, member]));
  const billableUnpaidMemberIds = uniqueIds.filter(
    (id) => {
      const policy = membershipTypePolicies.get(id);
      if (policy?.subscriptionBehavior === "NOT_REQUIRED") {
        return false;
      }
      const subscription = subscriptionById.get(id);
      // BASED_ON_AGE_TIER (issue #2041): a NOT_REQUIRED season row is
      // authoritative for a tier-exempt member and dominates their stored
      // ageTier, so a member who was exempt at season start stays not-billable
      // even if their stored tier is promoted mid-season (decision Q4). Scoped
      // to BASED_ON_AGE_TIER so REQUIRED types are byte-unchanged.
      if (
        policy?.subscriptionBehavior === "BASED_ON_AGE_TIER" &&
        subscription?.status === "NOT_REQUIRED"
      ) {
        return false;
      }
      // BASED_ON_AGE_TIER otherwise defers to the same per-age-tier flag as
      // REQUIRED (decision Q2), so both fall through to this age-tier check.
      return subscription?.status !== "PAID"
        && (!memberById.has(id)
          || requiresPaidSubscriptionForAgeTier(
            memberById.get(id)!.ageTier,
            ageTierSettings
          ));
    }
  );

  if (billableUnpaidMemberIds.length === 0) {
    return [];
  }

  // D-8 (MG2 #2307) — a cross-family member guest with an unpaid subscription is
  // refused NEUTRALLY, and this function throws rather than returning a row.
  //
  // This refusal was the most disclosive of the three D-8 collapses: the create
  // route returned the member's NAME, their subscription STATUS, their Xero
  // invoice NUMBER and a link to their invoice, and the guest-add route returned
  // their name in the message text. Against a member of the booker's own family
  // that is the helpful thing to do — someone in the household can act on it —
  // and family-scope adds keep it verbatim. Against a member the caller may never
  // have met it is a financial-status oracle that any logged-in member could
  // query one id at a time.
  //
  // Refusing here rather than at each route is deliberate, and follows the same
  // rule as the person-night guard: the marker rides the guest, so the collapse
  // reaches every caller of this helper (the create route, the guest-add route,
  // and anything added later) instead of the two that remembered.
  const refusedCrossFamily = params.guests.some(
    (guest) =>
      guest.crossFamilyMemberGuest === true &&
      guest.memberId &&
      billableUnpaidMemberIds.includes(guest.memberId),
  );
  if (refusedCrossFamily) {
    throw new BookingGuestValidationError(
      MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
      MEMBER_GUEST_CROSS_FAMILY_REFUSAL_STATUS,
    );
  }

  const nameById = new Map(
    linkedMembers.map((member) => [
      member.id,
      `${member.firstName} ${member.lastName}`.trim() || member.id,
    ])
  );

  return billableUnpaidMemberIds.map((id) => {
    const subscription = subscriptionById.get(id);
    return {
      memberId: id,
      name: nameById.get(id) ?? id,
      status: subscription?.status ?? "NOT_INVOICED",
      invoiceUrl: subscription?.xeroOnlineInvoiceUrl ?? null,
      invoiceNumber: subscription?.xeroInvoiceNumber ?? null,
    };
  });
}

export async function findUnpaidMemberGuestNames(
  db: BookingMemberGuestSubscriptionDb,
  params: {
    bookingMemberId: string;
    checkIn: Date;
    guests: BookingGuestLike[];
  }
): Promise<string[]> {
  const unpaidMembers = await findUnpaidMemberGuests(db, params);
  return unpaidMembers.map((member) => member.name);
}
