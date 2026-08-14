import type { XeroContactUpdateData } from "@/lib/xero-contacts";
import { prisma } from "@/lib/prisma";
import { getXeroContactNameOrderRepair } from "@/lib/xero-contact-link-mismatches";
import { formatXeroContactDateOfBirth } from "@/lib/xero-contact-date-of-birth";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";

export type MemberXeroContactSnapshot = XeroContactUpdateData & {
  firstName: string;
  lastName: string;
};

export type LinkedMemberXeroContactSnapshot = MemberXeroContactSnapshot & {
  xeroContactId?: string | null;
};

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A date of birth compared as the CALENDAR DAY it is, not the instant it is
 * stored as (#2859). Two `Date` objects for the same birthday are never `===`,
 * and comparing `getTime()` would report a change for a row the #2859 migration
 * re-encoded without altering the day it means.
 */
function normalizeOptionalDateOfBirth(
  value: Date | null | undefined,
): string | null {
  return formatXeroContactDateOfBirth(value);
}

export function buildXeroContactUpdatePayload(
  member: MemberXeroContactSnapshot
): XeroContactUpdateData {
  return {
    firstName: member.firstName,
    lastName: member.lastName,
    // A club-internal walk-in placeholder (#1935) must never be pushed to Xero
    // as a real address on a contact update; normalise it to empty.
    email: isPlaceholderContactEmail(member.email) ? "" : member.email,
    // #2859: the date of birth reaches Xero's NZBN field. Carried here so the
    // authoritative payload rebuilt under the Member lock has it; the writer
    // decides whether it may be sent.
    dateOfBirth: member.dateOfBirth ?? null,
    phoneCountryCode: member.phoneCountryCode ?? null,
    phoneAreaCode: member.phoneAreaCode ?? null,
    phoneNumber: member.phoneNumber ?? null,
    streetAddressLine1: member.streetAddressLine1 ?? null,
    streetAddressLine2: member.streetAddressLine2 ?? null,
    streetCity: member.streetCity ?? null,
    streetRegion: member.streetRegion ?? null,
    streetPostalCode: member.streetPostalCode ?? null,
    streetCountry: member.streetCountry ?? null,
    postalAddressLine1: member.postalAddressLine1 ?? null,
    postalAddressLine2: member.postalAddressLine2 ?? null,
    postalCity: member.postalCity ?? null,
    postalRegion: member.postalRegion ?? null,
    postalPostalCode: member.postalPostalCode ?? null,
    postalCountry: member.postalCountry ?? null,
  };
}

export function hasMemberXeroContactChanges(
  previous: MemberXeroContactSnapshot,
  next: MemberXeroContactSnapshot
): boolean {
  return (
    normalizeOptionalString(previous.email) !== normalizeOptionalString(next.email) ||
    // #2859: a date-of-birth edit is now a reason to talk to Xero, because the
    // date of birth is now something Xero is told. Clearing one still queues an
    // update, which then sends no `companyNumber` at all — this app asserts a
    // date of birth it holds and never erases one it does not.
    normalizeOptionalDateOfBirth(previous.dateOfBirth) !==
      normalizeOptionalDateOfBirth(next.dateOfBirth) ||
    normalizeOptionalString(previous.phoneCountryCode) !== normalizeOptionalString(next.phoneCountryCode) ||
    normalizeOptionalString(previous.phoneAreaCode) !== normalizeOptionalString(next.phoneAreaCode) ||
    normalizeOptionalString(previous.phoneNumber) !== normalizeOptionalString(next.phoneNumber) ||
    normalizeOptionalString(previous.streetAddressLine1) !== normalizeOptionalString(next.streetAddressLine1) ||
    normalizeOptionalString(previous.streetAddressLine2) !== normalizeOptionalString(next.streetAddressLine2) ||
    normalizeOptionalString(previous.streetCity) !== normalizeOptionalString(next.streetCity) ||
    normalizeOptionalString(previous.streetRegion) !== normalizeOptionalString(next.streetRegion) ||
    normalizeOptionalString(previous.streetPostalCode) !== normalizeOptionalString(next.streetPostalCode) ||
    normalizeOptionalString(previous.streetCountry) !== normalizeOptionalString(next.streetCountry) ||
    normalizeOptionalString(previous.postalAddressLine1) !== normalizeOptionalString(next.postalAddressLine1) ||
    normalizeOptionalString(previous.postalAddressLine2) !== normalizeOptionalString(next.postalAddressLine2) ||
    normalizeOptionalString(previous.postalCity) !== normalizeOptionalString(next.postalCity) ||
    normalizeOptionalString(previous.postalRegion) !== normalizeOptionalString(next.postalRegion) ||
    normalizeOptionalString(previous.postalPostalCode) !== normalizeOptionalString(next.postalPostalCode) ||
    normalizeOptionalString(previous.postalCountry) !== normalizeOptionalString(next.postalCountry)
  );
}

export async function shouldRepairXeroContactNameOrder(
  member: LinkedMemberXeroContactSnapshot
): Promise<boolean> {
  const xeroContactId = member.xeroContactId?.trim();
  if (!xeroContactId) {
    return false;
  }

  const cachedContact = await prisma.xeroContactCache.findUnique({
    where: { contactId: xeroContactId },
    select: {
      name: true,
      firstName: true,
      lastName: true,
    },
  });

  if (!cachedContact) {
    return false;
  }

  return Boolean(getXeroContactNameOrderRepair(member, cachedContact));
}
