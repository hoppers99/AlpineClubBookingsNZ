/**
 * The persistent "these messages were never sent" warning for a booking with
 * the "No emails" switch (#2259, owner decision D10).
 *
 * D10's compensating control has two halves. The acknowledgement dialog
 * (`booking-no-emails-controls.tsx`) makes the admin state the obligation
 * before anything is suppressed; THIS states what the obligation now covers,
 * every time the booking is opened, from the audit record rather than from a
 * static sentence. A fixed "some emails may have been withheld" would be
 * useless: the admin has to know which messages the member never received in
 * order to relay them, and the list includes the invoice emails Xero would have
 * sent on our behalf, which are inside the same guarantee.
 *
 * It renders in two shapes:
 *
 *  - switch ON: danger tokens, because the silence is ongoing;
 *  - switch OFF but rows exist: warning tokens, because the obligation did not
 *    expire when the switch was cleared. Turning emails back on does not re-send
 *    anything, so a member who was never told about a cancellation is still
 *    never told. This is the case a "show it only while the switch is on"
 *    banner would quietly drop.
 *
 * Presentational and admin-only: the booking page mounts it inside its
 * admin-tools gate and never computes the withheld list for a member. Nothing
 * here is safe to show a member — a member must never learn the switch exists.
 */
export interface WithheldEmailRow {
  id: string;
  /** Registry display name (`withheldEmailDisplayName`), not a raw slug. */
  label: string;
  subject: string;
  /** ISO timestamp. */
  createdAt: string;
}

export function BookingWithheldEmailsBanner({
  noEmails,
  withheld,
}: {
  noEmails: boolean;
  withheld: WithheldEmailRow[];
}) {
  // Nothing to warn about: emails are on and nothing was ever withheld.
  if (!noEmails && withheld.length === 0) return null;

  const tone = noEmails
    ? "border-danger-6 bg-danger-3 text-danger-11"
    : "border-warning-6 bg-warning-3 text-warning-11";

  return (
    <div
      id="no-emails"
      data-testid="booking-withheld-emails-banner"
      className={`scroll-mt-20 space-y-3 rounded-md border px-4 py-3 text-sm ${tone}`}
    >
      <div className="space-y-1">
        <p className="font-medium">
          {noEmails
            ? "Emails are turned off for this booking"
            : "Some emails for this booking were never sent"}
        </p>
        <p>
          {noEmails
            ? "Nothing is being sent to the member about this booking — confirmations, changes, payments, reminders, arrival information, cancellations, waitlist offers, chore rosters and the Xero invoice email are all withheld."
            : "Emails are on again, but the messages below were withheld while the switch was on and are not re-sent."}{" "}
          <span className="font-medium">
            Telling the member about these is your responsibility, not the
            system&apos;s.
          </span>
        </p>
      </div>

      {withheld.length === 0 ? (
        <p>Nothing has been withheld yet.</p>
      ) : (
        <div className="space-y-1">
          <p className="font-medium">
            Withheld so far ({withheld.length}
            {withheld.length === 1 ? " message" : " messages"}):
          </p>
          <ul className="list-inside list-disc space-y-1">
            {withheld.map((row) => (
              <li key={row.id}>
                <span className="font-medium">{row.label}</span>
                {" — "}
                <span>{row.subject}</span>
                {" ("}
                {new Date(row.createdAt).toLocaleString("en-NZ")}
                {")"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
