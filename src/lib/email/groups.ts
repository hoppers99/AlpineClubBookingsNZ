import {
  bookingRequestVerificationTemplate,
} from "@/lib/email-templates/booking-requests";
import {
  groupJoinCancelledTemplate,
  groupJoinReleasedTemplate,
  groupJoinSettledTemplate,
  groupSettlementExpiredTemplate,
  groupSettlementReceiptTemplate,
} from "@/lib/email-templates/groups";
import { CLUB_NAME } from "@/config/club-identity";
import {
  formatNZDate,
  formatNZDateTime,
} from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendEmail } from "./core";
import {
  classifyBookingOwnerContext,
  type BookingEmailSourceContext,
} from "@/lib/booking-email-contract";

/**
 * Verification email for a non-member joining a group booking. Reuses the
 * booking-request verification template but points the link at the group-join
 * verify page (/join/verify/[token]) rather than the booking-request one.
 */
export async function sendGroupBookingJoinVerificationEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  token: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expiresAt: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/join/verify/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Confirm your group booking spot — ${CLUB_NAME}`,
    html: bookingRequestVerificationTemplate({
      firstName: params.firstName,
      verifyUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      expiresAt: params.expiresAt,
    }),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-booking-join-verification",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      verifyUrl,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      guestCount: params.guestCount,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

/** Receipt to the organiser after they settle an ORGANISER_PAYS group bill. */
export async function sendGroupSettlementReceiptEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your group booking is settled — ${CLUB_NAME}`,
    html: groupSettlementReceiptTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      joinerCount: params.joinerCount,
      totalCents: params.totalCents,
    }),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-settlement-receipt",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      joinerCount: params.joinerCount,
      total: formatMoneyCents(params.totalCents),
    },
  });
}

/** Confirmation to a joiner whose spot the organiser has settled for them. */
export async function sendGroupJoinSettledEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your spot is confirmed — ${CLUB_NAME}`,
    html: groupJoinSettledTemplate({
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
    }),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-join-settled",
    templateData: {
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      guestCount: params.guestCount,
    },
  });
}

/** Organiser notice that their abandoned combined payment released the beds. */
export async function sendGroupSettlementExpiredEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your group payment expired — ${CLUB_NAME}`,
    html: groupSettlementExpiredTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      joinerCount: params.joinerCount,
      totalCents: params.totalCents,
    }),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-settlement-expired",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      joinerCount: params.joinerCount,
      total: formatMoneyCents(params.totalCents),
    },
  });
}

/** Joiner notice that the organiser's abandoned payment released their bed. */
export async function sendGroupJoinReleasedEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your held spot has been released — ${CLUB_NAME}`,
    html: groupJoinReleasedTemplate({
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    }),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-join-released",
    templateData: {
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
    },
  });
}

/**
 * Joiner notice that their reaped organiser-pays place reached its terminal
 * state (#1094): the group settlement was never retried, so the pending
 * booking has been cancelled.
 */
export async function sendGroupJoinCancelledEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your group booking has been cancelled — ${CLUB_NAME}`,
    html: groupJoinCancelledTemplate({
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    }),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-join-cancelled",
    templateData: {
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
    },
  });
}
