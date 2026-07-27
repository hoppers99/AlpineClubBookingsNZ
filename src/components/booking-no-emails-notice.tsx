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
  "Emails are off for this booking, so nothing will be sent to the member. You are responsible for telling them directly.";

export function BookingNoEmailsNotice({ className }: { className?: string }) {
  return (
    <p
      data-testid="booking-no-emails-notice"
      className={`rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11 ${className ?? ""}`}
    >
      {BOOKING_NO_EMAILS_PROMPT_NOTE}
    </p>
  );
}
