export interface BookingFamilyMember {
  relationship: "self" | "partner" | "dependent";
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  confirmationMode?: "self" | "delegated" | "not_allowed" | string | null;
  canLogin?: boolean | null;
  canBeBooked?: boolean | null;
  missingFields?: string[];
  needsOwnLoginConfirmation?: boolean | null;
  canCurrentUserConfirmDetails?: boolean | null;
  pendingRequestStatus?: string | null;
  pendingRequests?: Array<{
    id: string;
    type: string;
    status: string;
    familyGroupId: string;
  }>;
  pendingRequestFamilyGroupIds?: string[];
  bookableFamilyGroupIds?: string[];
  action?: string | null;
}

export function shouldShowInviteFamilyGroupMembersLink(
  familyMembers: BookingFamilyMember[]
): boolean {
  return !familyMembers.some((member) => member.relationship !== "self");
}

function getMemberName(member: BookingFamilyMember) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || "This member";
}

function isConfirmationExemptAccount(member: BookingFamilyMember) {
  return member.confirmationMode === "not_allowed";
}

// Consequence appended to the block message when the member could instead add
// this person as a non-member guest AND the non-member hold policy would apply
// to the stay (#1942). It spells out what "add them as a non-member guest"
// actually means so the choice is informed, not a surprise at check-in.
const PROVISIONAL_HOLD_CONSEQUENCE =
  " If you add them as a non-member guest, they'll be held provisionally — no bed is reserved for them until the booking is confirmed and paid closer to your stay, and members have priority if the lodge fills up.";

export function getFamilyMemberBookingBlockMessage(
  member: BookingFamilyMember,
  options?: { holdPolicyApplies?: boolean }
): string | null {
  if (member.canBeBooked !== false) {
    return null;
  }

  const name = getMemberName(member);
  // Only warn about the provisional consequence when the hold would actually
  // apply to this stay; otherwise adding them as a non-member guest holds a bed
  // immediately and the warning would be misleading.
  const consequence = options?.holdPolicyApplies
    ? PROVISIONAL_HOLD_CONSEQUENCE
    : "";

  if (member.pendingRequestStatus) {
    return `This family change is awaiting admin approval. You can add them as a non-member guest until approved.${consequence}`;
  }

  if (isConfirmationExemptAccount(member)) {
    return `${name} does not need member detail confirmation and cannot be added as a member guest.`;
  }

  if (member.canLogin) {
    return `${name} has their own login and needs to sign in and confirm their details before they can be booked as a member.${consequence}`;
  }

  if (member.canCurrentUserConfirmDetails) {
    return `Complete ${name}'s details before booking them as a member. Because ${name} does not have their own login, any adult in this family group can do this.${consequence}`;
  }

  return `${name}'s member details need to be completed or confirmed before they can be booked as a member.${consequence}`;
}

export function getFamilyMemberBookingActionLabel(
  member: BookingFamilyMember
): string | null {
  if (member.canBeBooked !== false) {
    return null;
  }

  if (member.pendingRequestStatus || member.action === "pending_admin_approval") {
    return "Pending admin approval";
  }

  if (isConfirmationExemptAccount(member)) {
    return null;
  }

  if (member.action === "complete_details") {
    return "Complete details";
  }

  if (member.action === "own_login_required") {
    return "Ask them to sign in and confirm";
  }

  if (member.action === "contact_admin") {
    return "Contact admin";
  }

  return null;
}
