- **The family-group invitation link no longer leaves the invite code in your
  browser's address bar or history.** The "I already have an account" and "Sign
  in with a different account" buttons on an invitation used to carry the
  invitation's own code in their web address, so it appeared in the address bar
  and stayed in the browser's history afterwards — where a shared or family
  computer keeps it, and where anything that records addresses can pick it up.

  The sign-in button is now an ordinary link, and where to send you afterwards is
  remembered privately by the server instead: in a short-lived cookie the page
  itself cannot read, written only when somebody actually opens the invitation,
  discarded the moment the sign-in lands back on it, and expiring after two
  minutes in any case.

  Nothing changes for the person invited. The emailed link still works, signing
  in still brings them back to the invitation whichever way they sign in
  (including Google and a two-factor challenge), the sign-in button still works
  with JavaScript switched off, and if the remembered address has expired they
  simply land on their usual page instead.

  If you are signed in as a different member, that page now offers **"Sign out
  and use a different account"**, which actually works — the old button sent you
  straight back to the same screen.

  Nothing an operator has to configure.
