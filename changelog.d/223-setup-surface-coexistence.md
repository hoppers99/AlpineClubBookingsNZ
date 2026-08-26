- **The setup checklist and the setup wizard can no longer disagree about what
  is outstanding (#223).** Both surfaces now work out the list of setup steps
  from the same place, so the number of outstanding items — and which items they
  are — is one answer shown two ways: as a percentage down the wizard's rail, or
  as cards grouped by category on the checklist.

  What you will notice is that **switching a module off now removes its setup
  steps from the checklist too**, as it already did from the wizard. Turn Xero
  off and the Operational Xero and Xero Mappings cards stop appearing, and the
  progress figure recalculates around what is left; with **both** Xero and the
  finance dashboard off there is no finance setup left at all, so the Finance
  hub card goes too. Nothing is deleted and nothing is remembered: the module toggle
  is the only record that the club said no, so turning it back on brings the
  steps back with whatever progress had already been recorded against them. A
  hub card is likewise offered only while at least one of the steps behind it
  still applies, so a drill-down can no longer open a page that has nothing in
  it. Membership & Members and Email Messages / Notifications cover no checklist
  step at all and are unaffected.

  The Setup guide gains a **Which setup surface to use, and when** section
  covering the choice, this behaviour, and one thing that is easy to mistake for
  a third setup surface: `/admin/alpine-server/setup` is a provider-connection
  page like Xero Setup. It reads none of the setup-progress machinery, and
  finishing it does not move your setup percentage.

- **The setup wizard now offers the provider tests (#223).** Stripe, Email,
  Sentry and Operational Xero each have a **Test** button that pings the live
  service and reports what it said. It used to live only on the readiness
  checklist, so retiring the checklist would have taken it away; the wizard's
  step for each of those four now carries the same button, calling the same
  check, and the step's verdict and the progress figure move with the result.
  Support edit access is required, which is what the server has always asked
  for.

- **The setup checklist can now be retired once the wizard covers what you need
  (#223).** A new **Setup surfaces** setting at the foot of Admin → Setup &
  Configuration → Setup hides the readiness checklist and the four Initial
  Setup / Finance / Booking Rules / Operational Integrations hubs, leaving the
  setup wizard as the one way in. Site Style's own **Finish setup** button goes
  with them — that button published the public site, and once the surfaces are
  hidden the wizard's **Ready to open** screen is the single place that happens.
  Site Style still saves your colours, fonts and logo exactly as before.

  It ships **shown**, so nothing changes for any club until somebody switches
  it, and it is a switch rather than a one-way door: untick it and everything
  comes back exactly as it was. No setting, no step's progress and no theme
  value changes in either position. Following an old bookmark to one of the four
  hubs takes you back to the Setup page rather than to an error, and the Setup
  page itself always stays — it is where the switch lives. Membership & Members,
  Cancellation and Email Messages / Notifications keep their cards whatever you
  choose, because the wizard offers no route to those and hiding them would take
  a capability away rather than move it. The change is recorded in the audit log
  with who made it and which way.
