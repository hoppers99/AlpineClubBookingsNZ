import { BookingStatus, type Prisma } from "@prisma/client";
import { isQuotePricedBooking } from "@/lib/booking-modify-validation";
import type { MemberGuestConsentBlockedReason } from "@/lib/member-guest-consent-service";
import {
  predictConsentDeclineRefusal,
} from "@/lib/member-guest-consent-card";
import { prisma } from "@/lib/prisma";

/**
 * The admin exception list and its two filter-chip counts ("+ Add Member
 * Guest", epic #2305, MG2 #2307, owner decisions D-15 and MG2-M-3 as ticked).
 *
 * MG2-M-3: the exception list is a FILTER on the existing Admin › Bookings
 * list, not a new page. Two chips: "Waiting for consent · N" narrows the
 * ordinary bookings table to bookings holding an unanswered request;
 * "Consent needs attention · N" swaps the table for the rows below — the
 * requests that resolved (said no, or lapsed) but whose guest could NOT be
 * removed automatically.
 *
 * EACH CHIP'S NUMBER IS THE NUMBER OF ROWS CLICKING IT REVEALS. The waiting
 * count is BOOKINGS (that is what the filtered table lists — one booking may
 * hold several pending requests); the attention count is GUEST ROWS (that is
 * what the attention table lists, one row per stuck guest).
 *
 * WHY THE "why it is stuck" COLUMN IS RE-DERIVED FROM THE LIVE BOOKING rather
 * than read from a stored reason: the blocked reason is not a column (the
 * consent model's DECLINED/EXPIRED rows carry no reason field — the audit log
 * has it, but audit entries are not operational state), and the booking may
 * have CHANGED since the block: a second guest added since the LAST_GUEST
 * refusal means the real remedy today is "just retry", not "cancel the
 * booking". Deriving from the same facts the removal service would enforce
 * NOW keeps the operator's table honest about the present, exactly as the
 * member-facing card derives its warnings.
 */

export interface MemberGuestConsentQueueCounts {
  /** Bookings holding at least one unanswered (PENDING) consent request. */
  waitingBookings: number;
  /** Stuck guest rows: resolved requests whose removal was refused (D-15). */
  attentionGuests: number;
}

/**
 * Bookings the "waiting" chip's filtered table will actually show: the same
 * baseline the bookings list applies with no explicit status filter — DRAFT
 * excluded, deleted hidden — so the chip's count and the click's result agree.
 */
const WAITING_BOOKING_WHERE: Prisma.BookingWhereInput = {
  deletedAt: null,
  status: { not: BookingStatus.DRAFT },
  guests: { some: { consentStatus: "PENDING" } },
};

/**
 * Stuck rows needing a human. A CANCELLED booking is excluded: cancelling
 * released everything the stuck row was holding, so there is nothing left to
 * fix. DRAFT is excluded to match the list baseline the chip filters.
 */
const ATTENTION_GUEST_WHERE: Prisma.BookingGuestWhereInput = {
  consentStatus: { in: ["DECLINED", "EXPIRED"] },
  booking: {
    deletedAt: null,
    status: { notIn: [BookingStatus.DRAFT, BookingStatus.CANCELLED] },
  },
};

export async function loadMemberGuestConsentQueueCounts(
  db: typeof prisma = prisma,
): Promise<MemberGuestConsentQueueCounts> {
  const [waitingBookings, attentionGuests] = await Promise.all([
    db.booking.count({ where: WAITING_BOOKING_WHERE }),
    db.bookingGuest.count({ where: ATTENTION_GUEST_WHERE }),
  ]);
  return { waitingBookings, attentionGuests };
}

export interface MemberGuestConsentExceptionRow {
  bookingId: string;
  lodgeName: string | null;
  checkIn: Date;
  checkOut: Date;
  bookerName: string;
  guestFirstName: string;
  guestLastName: string;
  /** "Said no" vs "lapsed, never answered". */
  status: "DECLINED" | "EXPIRED";
  /** When they said no (DECLINED) or when the request lapsed (EXPIRED). */
  statusAt: Date | null;
  reason: MemberGuestConsentBlockedReason;
  /** The "Why it is stuck" column. */
  why: string;
  /** The "What fixes it" column — always the real remedy, never "ask the club". */
  fix: string;
}

/**
 * The two columns, per D-15's four reasons (plus the honest fallback). The
 * LAST_GUEST and QUOTE_PRICED sentences are the mockup's table copy verbatim;
 * the other three restate `describeConsentBlockedRemedy`'s wording split into
 * the same why/fix shape.
 */
export function describeConsentExceptionColumns(params: {
  reason: MemberGuestConsentBlockedReason;
  guestFirstName: string;
}): { why: string; fix: string } {
  const { reason, guestFirstName } = params;
  switch (reason) {
    case "LAST_GUEST":
      return {
        why: `${guestFirstName} is the only guest on this booking, so taking them off would leave it empty.`,
        fix: "Cancel the booking, or add another guest first.",
      };
    case "QUOTE_PRICED":
      return {
        why: "This booking was priced by hand, so the system will not reprice it.",
        fix: `Re-quote the request without ${guestFirstName}.`,
      };
    case "BOOKING_STATUS":
      return {
        why: "This booking's status does not allow guest changes.",
        fix: "Move it to a status that does, or cancel it.",
      };
    case "STAY_NOT_FUTURE":
      return {
        why: "This stay has already started, so the place cannot be released.",
        fix: "Check who actually arrived and adjust the booking directly.",
      };
    case "OTHER":
      return {
        why: "The booking could not be repriced automatically.",
        fix: `Open the booking and take ${guestFirstName} off through the edit flow.`,
      };
  }
}

/**
 * Classify why a surviving DECLINED/EXPIRED row is stuck, from the booking as
 * it stands NOW. The four predictable blockers reuse the member-card
 * prediction (same gates, same order as the removal service); a row none of
 * them explains is the settled-payment / repricing case, reported as OTHER.
 */
export function classifyLiveConsentExceptionReason(params: {
  bookingStatus: string;
  bookingCheckIn: Date;
  bookingGuestCount: number;
  isQuotePriced: boolean;
  today?: Date;
}): MemberGuestConsentBlockedReason {
  return predictConsentDeclineRefusal(params) ?? "OTHER";
}

export async function listMemberGuestConsentExceptions(
  db: typeof prisma = prisma,
): Promise<MemberGuestConsentExceptionRow[]> {
  const rows = await db.bookingGuest.findMany({
    where: ATTENTION_GUEST_WHERE,
    orderBy: { booking: { checkIn: "asc" } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      consentStatus: true,
      consentRespondedAt: true,
      consentExpiresAt: true,
      booking: {
        select: {
          id: true,
          status: true,
          checkIn: true,
          checkOut: true,
          lodge: { select: { name: true } },
          member: { select: { firstName: true, lastName: true } },
          guests: { select: { id: true } },
        },
      },
    },
  });

  return Promise.all(
    rows.map(async (row) => {
      const status = row.consentStatus === "DECLINED" ? "DECLINED" : "EXPIRED";
      const reason = classifyLiveConsentExceptionReason({
        bookingStatus: row.booking.status,
        bookingCheckIn: row.booking.checkIn,
        bookingGuestCount: row.booking.guests.length,
        isQuotePriced: await isQuotePricedBooking(db, row.booking.id),
      });
      const columns = describeConsentExceptionColumns({
        reason,
        guestFirstName: row.firstName,
      });
      return {
        bookingId: row.booking.id,
        lodgeName: row.booking.lodge?.name ?? null,
        checkIn: row.booking.checkIn,
        checkOut: row.booking.checkOut,
        bookerName:
          `${row.booking.member.firstName} ${row.booking.member.lastName}`.trim(),
        guestFirstName: row.firstName,
        guestLastName: row.lastName,
        status,
        statusAt:
          status === "DECLINED" ? row.consentRespondedAt : row.consentExpiresAt,
        reason,
        why: columns.why,
        fix: columns.fix,
      };
    }),
  );
}
