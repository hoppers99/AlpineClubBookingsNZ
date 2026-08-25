- **The setup wizard's launch panel now tells you what this installation
  actually is, instead of pointing you elsewhere to find out (#224).** The
  final **Ready to open** screen has always had two independent levers —
  making the public site visible, and confirming whether this installation is
  the club's live site or a test copy. Until now the second one was a stub: it
  said the answer existed and pointed at **Admin → Environment**, but did not
  show it.

  It now names the role directly on the panel — production, non-production, or
  not configured — and which source decided it: the deployment's own
  `APP_ENVIRONMENT_ROLE`, or a Full Administrator's safer override. On a
  non-production installation it states plainly what is withheld: no email
  goes to members, and every Xero contact it touches has its address replaced
  so Xero cannot reach a member from a copy either.

  Where nothing has declared the role, a banner explains what is paused —
  member email and Xero writes, both — and exactly what to set
  (`APP_ENVIRONMENT_ROLE=production` or `non-production` in this deployment's
  `.env`, then restart). The panel also reports how much application email is
  currently being held back for environment-safety reasons, and distinguishes
  why: a confirmed copy suppressing delivery on purpose is not the same as an
  undeclared installation failing closed, and neither is the same as a live
  site that has also (wrongly) declared a local mail capture. A club's own
  per-booking "No emails" choice is named separately too, so it is never
  mistaken for an environment-safety withhold.

  There is still no control here, and there never will be: declaring
  production remains a deployment action, by design, so a restored copy of the
  live database can never declare itself the live site from inside the app.
  The panel reads the same answer the **Production Or Non-Production** setup
  step and the Environment Safety admin page already read — nothing here is a
  second opinion.
