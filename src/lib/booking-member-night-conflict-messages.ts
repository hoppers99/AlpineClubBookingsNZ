/**
 * Plain-English copy for the "already booked on one of these nights" block
 * (#2250).
 *
 * The old copy ("<name> is already on a booking for one of these nights.")
 * named a person and nothing else: not which nights, and not what to do next.
 * Every message here answers all three — WHO is already booked, WHICH nights,
 * and WHAT to do about it — with the next step chosen from the actor-aware
 * flags the server already computed for this viewer (`canSelfRemove`,
 * `isOwnBooking`, `canOpenBooking`).
 *
 * DISCLOSURE RULE. A 409 body goes to whoever made the request, which may be a
 * member adding somebody else as a guest — they are not necessarily entitled to
 * see the other booking. So the summary sentence is composed ONLY from facts
 * the requester already supplied: the member they tried to book and the nights
 * they chose. The other booking's owner, status, and id are stated by
 * `describeBookingMemberNightConflictBooking`, which returns null unless the
 * server marked this viewer `canOpenBooking` (the booking's own owner, an
 * admin, or the conflicting guest themselves). Nothing here widens what
 * `findBookingMemberNightConflicts` puts on the wire.
 *
 * No Prisma or date-only imports: the booking wizard renders this copy in the
 * browser bundle.
 */

export type BookingMemberNightConflictCopyInput = {
  memberName: string;
  conflictingNights: string[];
  bookingStatus: string;
  bookingOwnerName: string;
  isOwnBooking?: boolean;
  canOpenBooking?: boolean;
  canSelfRemove?: boolean;
};

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Date-only lodge nights are plain "YYYY-MM-DD" strings; parse them as text so
// the rendered night never shifts with the reader's browser time zone.
function formatNight(night: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(night);
  if (!parts) return night;
  const month = MONTH_ABBREVIATIONS[Number(parts[2]) - 1];
  if (!month) return night;
  return `${Number(parts[3])} ${month} ${parts[1]}`;
}

function joinWithAnd(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function formatNightList(nights: readonly string[]): string {
  if (nights.length === 0) return "the nights you chose";
  const formatted = [...nights].sort().map(formatNight);
  if (formatted.length > 4) {
    return `${formatted.slice(0, 3).join(", ")} and ${formatted.length - 3} more nights`;
  }
  return joinWithAnd(formatted);
}

function formatBookingStatus(status: string): string {
  return status.toLowerCase().split("_").join(" ");
}

/**
 * "Already on another booking for 1 Jun 2026 and 2 Jun 2026." — the nights half
 * of the conflict card, sitting under the member's name.
 */
export function describeBookingMemberNightConflictNights(
  conflict: BookingMemberNightConflictCopyInput,
): string {
  const nights = formatNightList(conflict.conflictingNights);
  return conflict.canSelfRemove
    ? `Already on another booking for ${nights}.`
    : `Already on a booking for ${nights}.`;
}

/**
 * The other booking's owner and status — returned ONLY for a viewer the server
 * marked `canOpenBooking`. A member adding a guest who turns out to be on a
 * stranger's booking learns that the night is taken, never whose booking it is.
 */
export function describeBookingMemberNightConflictBooking(
  conflict: BookingMemberNightConflictCopyInput,
): string | null {
  if (!conflict.canOpenBooking) return null;
  if (conflict.isOwnBooking) {
    return `It is your own ${formatBookingStatus(conflict.bookingStatus)} booking.`;
  }
  return `It is a ${formatBookingStatus(conflict.bookingStatus)} booking made by ${conflict.bookingOwnerName}.`;
}

/** What this particular viewer can actually do about the clash. */
export function describeBookingMemberNightConflictNextStep(
  conflict: BookingMemberNightConflictCopyInput,
): string {
  if (conflict.canSelfRemove) {
    return "Take yourself off that booking to free those nights, or choose different dates.";
  }
  if (conflict.isOwnBooking) {
    return "Open that booking and change it, or choose different dates.";
  }
  if (conflict.canOpenBooking) {
    return "Open that booking to sort it out, or choose different dates.";
  }
  return "Ask whoever made that booking, or the club, to take them off it — or choose different dates.";
}

/**
 * The single sentence-pair used as the `error` on a 409 and as the wizard's
 * banner: who is already booked, which nights, and what to do next.
 */
export function buildBookingMemberNightConflictMessage(
  conflicts: readonly BookingMemberNightConflictCopyInput[],
): string {
  if (conflicts.length === 0) {
    // Defensive: every caller builds this from a non-empty conflict list.
    return "Someone in this party is already booked on one or more of these nights. Nobody can be on two bookings for the same night, so choose different dates.";
  }

  if (conflicts.length === 1) {
    const conflict = conflicts[0];
    const nights = formatNightList(conflict.conflictingNights);
    const situation = conflict.canSelfRemove
      ? `You are already on another booking for ${nights}.`
      : `${conflict.memberName} is already on a booking for ${nights}.`;
    return `${situation} ${describeBookingMemberNightConflictNextStep(conflict)}`;
  }

  const names = joinWithAnd([
    ...new Set(conflicts.map((conflict) => conflict.memberName)),
  ]);
  const nights = formatNightList([
    ...new Set(conflicts.flatMap((conflict) => conflict.conflictingNights)),
  ]);
  return `${names} are already on other bookings for ${nights}. Nobody can be on two bookings for the same night, so take them off this booking or choose different dates.`;
}
