/**
 * Plain-English copy for the "already booked on one of these nights" block
 * (#2250).
 *
 * The old copy ("<name> is already on a booking for one of these nights.")
 * named a person and nothing else: not which nights, and not what to do next.
 * Every message here answers all three — WHO is already booked, WHICH nights,
 * and WHAT to do about it — with the next step chosen from the actor-aware
 * flags the server already computed for this viewer (`canSelfRemove`,
 * `isOwnBooking`, `canOpenBooking`, `isSelfGuest`).
 *
 * DISCLOSURE RULE. A 409 body goes to whoever made the request, which may be a
 * member adding somebody else as a guest — they are not necessarily entitled to
 * see the other booking. So the summary sentence is composed ONLY from facts
 * the requester already supplied: the member they tried to book and the nights
 * they chose. The other booking's owner, status, and id are stated by
 * `describeBookingMemberNightConflictBooking`, which returns null unless the
 * server marked this viewer `canOpenBooking` (the booking's own owner, an
 * admin, or the conflicting guest themselves). Nothing here widens what
 * `findBookingMemberNightConflicts` puts on the wire — and since #2250 the two
 * agree exactly: an unentitled conflict row carries no booking fields at all,
 * so this copy has nothing to leak even if a future edit forgets the flag.
 *
 * FLOW RULE. Every producer of a member-night 409 routes through
 * `getBookingMemberNightConflictResponse` — the booking wizard, but also
 * `admin/booking-requests/[id]/approve|hold|send-quote` and the modify routes.
 * "…or choose different dates" is advice only the person *choosing* the dates
 * can act on, so it is opt-in via `canChooseDifferentDates` and the
 * server-built message stays flow-neutral.
 *
 * No Prisma import: the booking wizard renders this copy in the browser bundle.
 * `@/lib/date-only` and `@/lib/nzst-date` import only `@/config/operational`,
 * so both are client-safe — several client components already import them, and
 * `admin-booking-calendar.tsx` does exactly this `formatNZDate(parseDateOnly())`
 * pairing in the browser.
 */

import { parseDateOnly } from "@/lib/date-only";
import { formatNZDate } from "@/lib/nzst-date";

export type BookingMemberNightConflictCopyInput = {
  memberName: string;
  conflictingNights: string[];
  /**
   * Optional because the 409 payload omits them for a viewer the server did not
   * mark `canOpenBooking` — see the disclosure rule above. Every sentence that
   * reads them is behind that same flag, and fails closed if one is missing.
   */
  bookingStatus?: string;
  bookingOwnerName?: string;
  isOwnBooking?: boolean;
  canOpenBooking?: boolean;
  canSelfRemove?: boolean;
  /**
   * The clashing guest row IS the viewer. Set independently of
   * `canSelfRemove`, which is false for the most common clash of all — the
   * member against a booking they made themselves — and would otherwise leave
   * them addressed in the third person.
   */
  isSelfGuest?: boolean;
};

/** Where the copy is read, as opposed to who reads it. */
export type BookingMemberNightConflictCopyOptions = {
  /**
   * The reader is picking the dates (the booking wizard). Only then may the
   * copy suggest choosing different ones: an admin approving, holding, or
   * quoting a booking request reads the same 409 and cannot act on that advice.
   */
  canChooseDifferentDates?: boolean;
};

// Date-only lodge nights are plain "YYYY-MM-DD" strings. `parseDateOnly` pins
// them to UTC midnight and `formatNZDate` renders them in the club time zone,
// so the night never shifts with the reader's browser time zone AND it follows
// the app's configured locale rather than a hardcoded English month table.
function formatNight(night: string): string {
  const parsed = parseDateOnly(night);
  return Number.isNaN(parsed.getTime()) ? night : formatNZDate(parsed);
}

function joinWithAnd(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capitaliseFirst(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
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
 * Does this row describe the VIEWER? `canSelfRemove` is only ever true for the
 * viewer's own guest row (see `evaluateGuestSelfRemoval`), so it implies self
 * even where a producer has not set `isSelfGuest`.
 */
function isViewersOwnPlace(
  conflict: BookingMemberNightConflictCopyInput,
): boolean {
  return Boolean(conflict.isSelfGuest || conflict.canSelfRemove);
}

/**
 * "Already on another booking for 1 Jun 2026 and 2 Jun 2026." — the nights half
 * of the conflict card, sitting under the member's name.
 */
export function describeBookingMemberNightConflictNights(
  conflict: BookingMemberNightConflictCopyInput,
): string {
  const nights = formatNightList(conflict.conflictingNights);
  return isViewersOwnPlace(conflict)
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
  // Fail closed. An entitled row always carries these, so a missing one means
  // the payload was scoped — say nothing rather than "It is a undefined
  // booking."
  if (!conflict.bookingStatus) return null;
  const status = formatBookingStatus(conflict.bookingStatus);
  if (conflict.isOwnBooking) {
    return `It is your own ${status} booking.`;
  }
  if (!conflict.bookingOwnerName) return null;
  return `It is a ${status} booking made by ${conflict.bookingOwnerName}.`;
}

/** What this particular viewer can actually do about the clash. */
export function describeBookingMemberNightConflictNextStep(
  conflict: BookingMemberNightConflictCopyInput,
  { canChooseDifferentDates = false }: BookingMemberNightConflictCopyOptions = {},
): string {
  const orOtherDates = canChooseDifferentDates
    ? ", or choose different dates"
    : "";
  if (conflict.canSelfRemove) {
    return `Take yourself off that booking to free those nights${orOtherDates}.`;
  }
  if (conflict.isOwnBooking) {
    return `Open that booking and change it${orOtherDates}.`;
  }
  if (conflict.canOpenBooking) {
    return `Open that booking to sort it out${orOtherDates}.`;
  }
  // This sentence already carries a comma, so the alternative hangs off a dash.
  return `Ask whoever made that booking, or the club, to take them off it${
    canChooseDifferentDates ? " — or choose different dates" : ""
  }.`;
}

/**
 * WHO is already booked and for WHICH nights — no next step. The wizard uses
 * this as its banner because the per-conflict cards underneath state the next
 * step for each clash themselves; the full message below is for callers that
 * render nothing but a single sentence.
 */
export function buildBookingMemberNightConflictSummary(
  conflicts: readonly BookingMemberNightConflictCopyInput[],
): string {
  if (conflicts.length === 0) {
    // Defensive: every caller builds this from a non-empty conflict list.
    return "Someone in this party is already booked on one or more of these nights.";
  }

  if (conflicts.length === 1) {
    const conflict = conflicts[0];
    const nights = formatNightList(conflict.conflictingNights);
    return isViewersOwnPlace(conflict)
      ? `You are already on another booking for ${nights}.`
      : `${conflict.memberName} is already on a booking for ${nights}.`;
  }

  // The viewer is addressed as "you" wherever they appear in the list, and the
  // verb agrees with the DE-DUPLICATED name count: one member on two clashing
  // bookings is two rows but still one person ("Alice Smith IS already on…").
  const viewerName = conflicts.find(isViewersOwnPlace)?.memberName;
  const names = [...new Set(conflicts.map((conflict) => conflict.memberName))];
  const labels = names.map((name) => (name === viewerName ? "you" : name));
  const nights = formatNightList([
    ...new Set(conflicts.flatMap((conflict) => conflict.conflictingNights)),
  ]);

  if (labels.length === 1) {
    const verb = labels[0] === "you" ? "are" : "is";
    return capitaliseFirst(
      `${labels[0]} ${verb} already on other bookings for ${nights}.`,
    );
  }
  return capitaliseFirst(
    `${joinWithAnd(labels)} are already on other bookings for ${nights}.`,
  );
}

/**
 * The self-contained sentence-pair used as the `error` on a 409: who is already
 * booked, which nights, and what to do next. Flow-neutral unless the caller
 * says the reader is choosing the dates.
 */
export function buildBookingMemberNightConflictMessage(
  conflicts: readonly BookingMemberNightConflictCopyInput[],
  options: BookingMemberNightConflictCopyOptions = {},
): string {
  const summary = buildBookingMemberNightConflictSummary(conflicts);

  if (conflicts.length === 1) {
    return `${summary} ${describeBookingMemberNightConflictNextStep(conflicts[0], options)}`;
  }

  const nextStep = options.canChooseDifferentDates
    ? "Nobody can be on two bookings for the same night, so take them off this booking or choose different dates."
    : "Nobody can be on two bookings for the same night, so somebody has to come off one of the bookings.";
  return `${summary} ${nextStep}`;
}
