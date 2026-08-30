- **The setup wizard's Membership Cancellation step now carries the real
  editor inline (#260).** It used to be a link out to `/admin/setup/cancellation`,
  a hub page with nothing to do on it directly. The step now shows the same
  editor as Admin → Membership Cancellation beneath the step's check — the
  cancellation warning copy, the rejoin-process text, and which Xero contact
  groups get archived when a cancellation is approved. It is the same editor
  saving through the same route, not a second copy, and Admin → Membership
  Cancellation is unchanged in what it does. Saving does not tick the step
  off: **Mark this step done** is still the one action that records that a
  person agreed.

  **The step's settings link was also corrected to point at the real editor,
  which moves its permission area from Support to Membership.** The old link
  went to the link-out hub, so its area was read off that hub's own URL
  prefix rather than off where the editing actually happens — the same
  mistake the club identity step's area carried until it was corrected
  earlier in this epic. A custom role with support access and no membership
  access could previously have opened this step and watched its settings
  link and permission line disagree with what the real editor would have
  required; now the link goes straight to the editor, the area follows it
  mechanically, and a viewer without membership access sees the ordinary
  link-out instead of an editor they cannot use.
