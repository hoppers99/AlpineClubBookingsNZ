/**
 * The one sentence every booking action shows in place of its notify-member
 * choice while the "No emails" switch is on (#2259, owner decision D10).
 *
 * The honesty rule behind the whole notify-prompt family (#1769a) is that an
 * admin is only asked a question the system will actually honour. With the
 * switch on, "email the member about this?" is no longer such a question: the
 * mailer withholds the message either way, so offering the choice would invite
 * the admin to pick "…and email member" and walk away believing the member was
 * told. Every one of those prompts therefore drops to the send-nothing path and
 * says this instead.
 *
 * It lives in one file, used by every affected surface, so the wording cannot
 * drift into a weaker claim on one screen than another — and so a single test
 * can assert the rule rather than five near-copies of it.
 *
 * Deliberately admin-only in placement: it renders inside admin confirmation
 * dialogs and admin review queues, never on a member-facing control. A member
 * must never learn the switch exists.
 */
const BOOKING_NO_EMAILS_PROMPT_NOTE =
  "Emails are off for this booking, so nothing will be sent to the member. You are responsible for telling them directly. The message is still recorded on the booking's withheld list.";

/**
 * The stale-page caveat. This state is read when the page renders, so a
 * colleague who cleared the switch a moment ago leaves this notice showing on
 * an open tab — and the admin then loses an email option they should have had.
 * The direction is the safe one (the member gets an email either way once the
 * switch is off, because the suppressed path sends no `notifyMember` at all),
 * but the admin's own expectation would be wrong, so say so rather than let
 * them wonder where the choice went.
 */
const BOOKING_NO_EMAILS_STALE_NOTE =
  "If emails were turned back on for this booking just now, refresh the page to get the email choice back.";

export function BookingNoEmailsNotice({ className }: { className?: string }) {
  return (
    <div
      data-testid="booking-no-emails-notice"
      className={`space-y-1 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11 ${className ?? ""}`}
    >
      <p>{BOOKING_NO_EMAILS_PROMPT_NOTE}</p>
      <p className="text-xs">{BOOKING_NO_EMAILS_STALE_NOTE}</p>
    </div>
  );
}
