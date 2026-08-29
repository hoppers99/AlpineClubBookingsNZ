- **The setup wizard no longer walks you through things you cannot change
  (#246).** Five of its twenty checks were never about your club at all — they
  report the state of the server the site runs on: whether this installation is
  declared the live site or a copy, the required runtime variables, the auth
  secret's strength, email delivery, and Sentry. Setting a club up meant meeting
  three of those in a row, being unable to act on any of them, and clicking past
  all three to reach the next thing you could do. Being asked to mark done
  something you have no way to change reads as a failing of yours, and it is not
  one.

  Those five now have their own screen, **About this server**, on the rail below
  the journey. Each row leads with **who does this** — for all five, whoever
  installed and runs the site rather than you — then gives you **the one line to
  send them**, written to be copied into an email and acted on by somebody who is
  not looking at the wizard, and then, behind a toggle, why it matters. A row
  that is fine stays on screen and reads green, so "all fine" is still
  distinguishable from "not checked yet".

  **The journey is fifteen steps instead of twenty, and eleven on a fresh
  install.** The percentage now divides by the steps you can actually do, so your
  first confirmation reads 9% rather than 6%. A brand-new club still opens at 0%,
  which was already true and has not changed.

  **Three of the five hold the public site shut**, and the wizard says so where
  it matters. If nothing has declared whether this installation is the live site
  or a copy, if a required runtime variable is missing or malformed, or if the
  auth secret is too weak for the site to store a Stripe or Xero credential, then
  **Ready to open** still opens and still shows you everything — but **Make the
  public site visible** is refused, with the reason and whose job it is stated
  beside the button. Email delivery and Sentry are worth an amber row and nothing
  more: neither stops you opening. **None of the five stop you working through
  the rest of the wizard.**

  **Nothing was taken away.** All twenty checks still appear on the readiness
  checklist at **Admin → Setup**, in the same words with the same verdicts, and
  `npm run setup:check` reports exactly what it did before — the checklist
  answers "is this installation configured?", where a deployment fact plainly
  belongs, and only the wizard's question ("has somebody been through this?")
  narrowed. The **Test Email** and **Test Sentry** buttons moved onto their new
  rows rather than disappearing with the steps, which is also the quickest way to
  find out whether a fix your server administrator has just made actually worked.

  If you upgraded a club that had already marked one of these five done, that
  record is simply ignored rather than lost. Nothing stored is rewritten and your
  **Setup complete** flag is untouched — the displayed percentage simply divides
  by the shorter list from now on, which is the one-off change described above.
