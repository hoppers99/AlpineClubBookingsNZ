- **The setup checklist and the setup wizard can no longer disagree about what
  is outstanding (#223).** Both surfaces now work out the list of setup steps
  from the same place, so the number of outstanding items — and which items they
  are — is one answer shown two ways: as a percentage down the wizard's rail, or
  as cards grouped by category on the checklist.

  What you will notice is that **switching a module off now removes its setup
  steps from the checklist too**, as it already did from the wizard. Turn Xero
  off and the Operational Xero and Xero Mappings cards stop appearing, the
  Finance hub card goes with them, and the progress figure recalculates around
  what is left. Nothing is deleted and nothing is remembered: the module toggle
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
