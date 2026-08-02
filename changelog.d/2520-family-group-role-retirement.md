- **Family groups no longer record a rank against each member (#2520).** The
  family-group membership row carried a `role` value of "ADMIN" or "MEMBER" that
  was handed out by accident of whichever flow created the group. It stopped
  granting anything in #2284, when the one power it gated — declaring a no-login
  adult co-member as your partner in one step — was re-anchored onto the adult
  actually recorded as having confirmed that member's details.

  This release stops writing it anywhere: creating a group as an admin, approving
  a group-create or join request, accepting an invitation, linking a dependent,
  approving a nomination, claiming a partner invite, the Xero member import, the
  family-suggestion group builder, and the demo seed all now record membership
  and nothing more. A member merge no longer promotes the surviving membership
  row either, every family-group lookup was narrowed so the column is not even
  read back, and the value is now hidden from the database layer outright, so it
  cannot be written or read by accident.

  Every admin family-group response and the member onboarding response were
  still handing the value out to the browser, so those fields are gone too. No
  screen, email, permission or report ever varied by it — the admin family-group
  pages and the onboarding wizard received the value and never displayed it — so
  nothing an administrator or member can see changes. What changes is that the
  club's data no longer implies one family member outranks another: every adult
  with a login in a family group is equal, which is what the club's rules already
  said.

  The column is deliberately left in the database for one more release. Removing
  it is a destructive migration that is only safe to run once this release is
  live, so it ships as the second half of #2520 in a later release. Nothing for
  an operator to do now, and the values still stored in the column are harmless:
  they are simply no longer consulted by anything.
