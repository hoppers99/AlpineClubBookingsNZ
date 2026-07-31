import { getAppBaseUrl } from "@/lib/app-url";

/**
 * The recipient identity a booking-scoped sender must declare.
 *
 * A member id is only an input to the server-side authority check; it is never
 * treated as proof that the recipient may open the booking. Public contacts and
 * aggregate operator messages are explicit so neither can accidentally inherit
 * a signed-in booking link merely because a booking id is available.
 */
export type BookingEmailRecipient =
  | { kind: "member"; memberId: string }
  | { kind: "non-login-public-contact" }
  | { kind: "aggregate-operator" };

export type BookingEmailRecipientAuthority =
  | "signed-in-booking-owner"
  | "signed-in-linked-member"
  | "bookings-view-admin"
  | "non-login-public-contact"
  | "aggregate-operator"
  | "unauthorized";

/**
 * Booking identity for a send. Every booking-scoped caller must name both the
 * booking and the recipient whose authority will be checked before a detail
 * link is rendered.
 */
export type EmailBookingContext =
  | { bookingId: string; recipient: BookingEmailRecipient }
  | "none";

export type BookingScopedEmailContext = Exclude<EmailBookingContext, "none">;

export type BookingEmailSourceContext =
  | { bookingId: string; recipientMemberId: string }
  | "none";

export function bookingOwnerEmailContext(
  bookingId: string,
  recipientMemberId: string,
): BookingScopedEmailContext {
  return {
    bookingId,
    recipient: { kind: "member", memberId: recipientMemberId },
  };
}

export function classifyBookingOwnerContext(
  context: BookingEmailSourceContext,
): EmailBookingContext {
  return context === "none"
    ? "none"
    : bookingOwnerEmailContext(context.bookingId, context.recipientMemberId);
}

/** Canonical, encoded member-facing booking detail path. */
export function buildBookingDetailPath(bookingId: string): string {
  return `/bookings/${encodeURIComponent(bookingId)}`;
}

/** Canonical absolute URL used in email HTML and editable template data. */
export function buildBookingDetailUrl(bookingId: string): string {
  return `${getAppBaseUrl()}${buildBookingDetailPath(bookingId)}`;
}
