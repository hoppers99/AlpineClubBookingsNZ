/**
 * The short, human-readable handle for a booking (#2576 §6).
 *
 * Bookings are keyed by cuid, which nobody can read out over the phone or match
 * against the reference on their confirmation email. The admin occupancy report
 * has shown an 8-character uppercase prefix since it shipped, and #2576 needs the
 * same handle in a MEMBER-facing refusal ("this change would leave booking
 * A1B2C3D4 without cover"), so the one rendering now lives here and both callers
 * read it.
 *
 * PREFIX, NOT A HASH, and deliberately so: it is derived from the id the member
 * can see in their own booking URL, so the two agree, and a support conversation
 * can go either way between them. It is not claimed to be unique — a cuid's first
 * 8 characters are its timestamp-ish prefix, so two bookings created in the same
 * moment can share one — which is why it is only ever DISPLAYED beside the lodge
 * and the dates, and never used to look a booking up.
 */
export function formatBookingReference(bookingId: string): string {
  return bookingId.slice(0, 8).toUpperCase();
}
