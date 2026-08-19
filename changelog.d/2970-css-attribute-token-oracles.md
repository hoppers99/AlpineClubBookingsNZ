- **One-time link tokens no longer sit in a page's links or attributes (#2827).**
  Site-Style **Raw CSS** is a trusted admin capability, but a CSS attribute
  selector can read a value one character at a time — so on the pages that carry
  Raw CSS, any secret in an attribute was readable by whoever edits the club's
  styling, which includes a content-area admin who is not a Full Admin. Three
  places were putting a one-time token where it did not belong, and all three are
  closed.

  On the group-join confirmation page, the "if you are not redirected" fallback
  was a link containing the pay-by-link token, on a page that **does** carry Raw
  CSS. It is now a button that navigates from the token the page already holds in
  memory, so nothing selectable carries it. The automatic redirect is unchanged,
  and no path is lost — reaching that screen at all requires the Confirm step that
  fetches the token.

  The footer's per-page styling hook (`data-page-slug`, which lets Raw CSS target
  one page) was stamping the raw address on the one-time-link pages under the
  login area, so it carried the token itself on `/pay`, `/chores`,
  `/family-invite` and `/membership-cancellation`. It now stamps the route shape —
  `pay/[token]` — exactly as the rest of the site already did, so styling one page
  still works and the token is gone. Those particular pages do not inject Raw CSS,
  so this is precaution rather than a hole being closed; it means the day they are
  moved under the shared page chrome, they cannot start leaking silently. A new
  one-time-link page added there without being registered now fails a test. The
  same work fixed a styling bug it uncovered: the membership application form
  (`/join/apply`) was being labelled as the group-join code page, so a club's CSS
  rule for either one landed on the wrong page.

  The family-group invitation page's "I already have an account" and "Sign in with
  a different account" buttons used to carry the invite token in their link, so
  the token appeared in the address bar and stayed in browser history. The
  sign-in button is now a plain link, and the return address is remembered
  privately by the server instead — in a short-lived cookie the page itself cannot
  read, which is written only when somebody actually opens the invitation, is
  discarded the moment the sign-in lands back on it, and expires after two minutes
  in any case. Nothing changes for the recipient: the emailed link still works,
  signing in still brings them back to the invitation whichever way they sign in
  (including Google and a two-factor challenge), the sign-in button still works
  with JavaScript switched off, and if the address has expired they simply land on
  their usual page. If you are signed in as a different member, that page now
  offers "Sign out and use a different account", which actually works — the old
  button sent you straight back to the same screen.

  Nothing an operator has to configure, and no page a member sees looks different.
