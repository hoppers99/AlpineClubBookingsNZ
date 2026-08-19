- **One-time link tokens no longer appear anywhere the club's own Raw CSS can
  read them (#2827).** Site-Style **Raw CSS** is a trusted admin capability, but a
  CSS attribute selector can read a value one character at a time — so any secret
  the page put into an attribute was readable by whoever edits the club's styling,
  which includes a content-area admin who is not a Full Admin. Three places were
  handing one over, and all three are closed.

  On the group-join confirmation page, the "if you are not redirected" fallback
  was a link containing the pay-by-link token. It is now a button that navigates
  from the token the page already holds in memory, so nothing selectable carries
  it. The automatic redirect is unchanged, and no path is lost — reaching that
  screen at all requires the Confirm step that fetches the token.

  The footer's per-page styling hook (`data-page-slug`, which lets Raw CSS target
  one page) was still stamping the raw address on the `(public)` one-time-link
  pages, so it carried the token itself on `/pay`, `/chores`, `/family-invite` and
  `/membership-cancellation`. It now stamps the route shape — `pay/[token]` —
  exactly as the rest of the site already did, so styling one page still works and
  the token is gone. A new one-time-link page added to that group without being
  registered now fails a test rather than silently reopening the hole.

  The family-group invitation page's "I already have an account" and "Sign in with
  a different account" buttons used to carry the invite token in their link, so
  that signing in brought the recipient back to the invitation. They are now plain
  sign-in links, and the return address is remembered privately by the server
  instead — in a short-lived cookie the page itself cannot read, which expires ten
  minutes after the page is opened and is discarded as soon as it has been used.
  Nothing changes for the recipient: the emailed link still works, signing in
  still brings them back to the invitation whichever way they sign in (including
  Google and a two-factor challenge), the buttons still work with JavaScript
  switched off, and if the address has expired they simply land on their usual
  page. The invitation is still bound to the invited email address — that check is
  unchanged, and is what keeps the flow safe even if somebody else's browser
  arrives holding the address.

  Nothing an operator has to configure, and no page a member sees looks different.
