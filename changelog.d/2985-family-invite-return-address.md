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
  in still brings them back to the invitation, the sign-in button still works
  with JavaScript switched off, and if the remembered address has expired they
  simply land on their usual page instead.

  If you are signed in as a different member, that page now offers **"Sign out
  and use a different account"**, which actually works — the old button sent you
  straight back to the same screen.

  Nothing an operator has to configure.

- **On a shared computer, opening somebody's invitation no longer shows it to the
  next person who signs in.** Remembering the invitation privately on the server
  fixed the address-bar problem above, but it remembered it for the whole
  *browser* rather than for the one tab. So if a member opened an invitation on a
  lodge or club computer, changed their mind and walked off without signing in,
  the next person to sign in on that computer within the next two minutes was
  taken to that invitation — where they could read who it was sent to and which
  family group it was for. They could never actually join it (the page still
  checks that the signed-in member's email matches the one invited), but they
  should not have seen it at all.

  The invitation is now tied to the tab it was opened in. Sign in from that tab
  and you are brought back to the invitation exactly as before, whichever way you
  sign in — password, Google, or through a two-factor challenge. Sign in from
  anywhere else and you land on your usual page, with nothing about somebody
  else's invitation on the screen.

  **One deliberate change for the invited person.** If you ask for a sign-in link
  by email rather than typing your password, that emailed link opens in a fresh
  tab, so it is no longer treated as coming from the invitation. You will land on
  your usual page after signing in; open the invitation link again from your email
  and it will let you join, which is what the page already asks you to do. Every
  other way of signing in still takes you straight back to the invitation.

  Nothing an operator has to configure.
