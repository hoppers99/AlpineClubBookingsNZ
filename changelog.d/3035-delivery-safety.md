- **A test or staging copy of the club's site no longer emails the club's real
  members (#3035).** A copy is normally restored from the live database, so it
  holds every member's real address. Until now the only thing standing between
  such a copy and the club's inbox was remembering to change the mail settings,
  and every send path had its own idea of when to send: the ordinary mailer, the
  job that retries failed mail, and the three places the accounting system is
  asked to email an invoice.

  All five now ask one question first — *is this installation the club's live
  site?* — and that question is answered by the single explicit declaration
  introduced in the previous release, never guessed from a hostname, a branch or a
  build mode.

  What an operator will notice, on each kind of installation:

  - **The club's live site behaves exactly as before.**
  - **A copy sends nothing**, and says so. Each held-back message is recorded
    against its own reason, kept separate from the per-booking "No emails" switch,
    so nobody reading the log later mistakes one for the other.
  - **An installation nobody has declared sends nothing either**, and this one is
    treated as a fault rather than as a decision: the message is queued, and it
    goes out by itself as soon as the role is declared. Nothing has to be
    re-triggered by hand.
  - **A site declared as both the live site and a mail capture is refused.** That
    combination would accept every message and deliver none of them, which is a
    silent mail outage, so it is stopped and named rather than allowed to run.

  Admin → Environment now shows **how much email this installation has held
  back, and when the most recent one was**. That number is what tells a live club
  that has been wrongly declared a copy apart from an ordinary staging copy — a
  real club withholds a steady, recent stream, while an unused copy withholds
  almost nothing. It reports "not available" rather than a reassuring zero if it
  cannot read the figure.

  A test installation that needs to *see* its own mail can declare a capture
  mailbox (`USE_LOCAL_CAPTURE=true`) pointed at a local sink that forwards
  nothing; a copy is then allowed to transmit into it. This is a deliberate
  declaration and never a guess, the live site refuses it, and it does not cover
  invoice emails — the accounting system sends those from its own servers to the
  member's real address, so a copy does not ask for one at all.

  One thing to check on upgrade: a deployment that sets neither `USE_AWS_SES` nor
  `USE_SMTP_RELAY` used to fall back to live AWS SES silently. The club's live
  site keeps that fallback; anything else now refuses to open a mail connection
  until one of the flags is set explicitly, so a copy cannot reach the club's mail
  provider by default.
