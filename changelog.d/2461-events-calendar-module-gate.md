- **The Events Calendar can now be switched off, and organisation accounts no
  longer see it (#2241).** The club events calendar shipped as an always-on
  feature: there was no toggle for a club that does not run one, and it was
  visible to every account that could log in — organisations included.

  It is now a module. **Admin → Modules → Events calendar** turns it on and off
  like any other, and it ships **on**, so an existing club sees no change at all.
  Switching it off makes the member calendar page, the admin calendar page and
  the calendar API return Not Found, and removes the **Events** card from the
  member dashboard. Nothing is deleted — the events are still there and reappear
  if you switch it back on. The choice travels with a club configuration
  transfer, alongside the other module switches.

  **Organisation accounts are excluded outright.** An organisation — a school,
  scout group, or similar body with its own self-service login for its bookings —
  is not a club member and has no business in the club's internal meeting and
  working-bee schedule. It now gets no Events card on its dashboard, and the
  calendar pages and the calendar API answer Not Found for it, whether the module
  is on or off. The rule is decided in one place and applied to reading and
  writing alike, so an organisation account that also happened to hold a
  committee assignment still cannot add an event.

  The guards on the two calendar pages are deliberately doubled up with the
  central module gate rather than left to it: a Next.js router *prefetch* skips
  that gate by design, so without the page-level check a prefetched render could
  still have produced the calendar.

  The operator diagnostic (`scripts/diagnose-calendar-access.ts`, the one the
  calendar guide sends you to for "why can this person do that?") reports the
  new legs in the order the app applies them: the module switch first, then the
  organisation check, then the create and edit/delete gates. It previously
  re-implemented only the old write gate, so it would have answered "CAN
  create" for an organisation account with a committee assignment.
