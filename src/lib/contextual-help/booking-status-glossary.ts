/**
 * The plain-English meaning of every booking status badge.
 *
 * ITS OWN MODULE, and it must stay that way. Member-facing pages render this
 * list (`bookings/[id]/_components/booking-help-extras.tsx`, a client
 * component) and so does `@/lib/help/member-help`. While it lived in the
 * 2,695-line admin help monolith, importing eleven strings meant importing the
 * whole admin corpus and hoping the bundler shook it out. Now it does not.
 *
 * One source of truth on purpose: the admin/finance contextual help below and
 * the member booking pages must render identical text (#1371 F28 / #1072).
 */

/**
 * Booking status glossary — the plain-English meaning of every booking status
 * badge a member (or operator) can see. Exported as a single source of truth so
 * both the admin/finance contextual help below and the member booking pages
 * (#1371 F28 / #1072) render the identical text.
 */
export const BOOKING_STATUS_GLOSSARY: string[] = [
  "Draft — saved but not submitted; holds no beds.",
  "Pending — provisional non-member hold; does not consume capacity.",
  "Awaiting Review — waiting on an admin decision; keeps its beds so approval cannot overbook.",
  "Payment Pending — awaiting payment; beds are not reserved until money is committed.",
  "Confirmed (Unpaid) — pay-on-account booking; the lodge is reserved while the emailed Xero invoice is outstanding, and it flips to Paid on reconciliation.",
  "Paid — paid in full; holds capacity.",
  "Completed — the stay has started or finished; keeps consuming capacity until checkout.",
  "Waitlisted — queued for a spot; no beds held.",
  "Waitlist Offered — a spot opened; time-limited offer to confirm and pay.",
  "Bumped — displaced when capacity changed; no beds held.",
  "Cancelled — cancelled; no beds held.",
];
