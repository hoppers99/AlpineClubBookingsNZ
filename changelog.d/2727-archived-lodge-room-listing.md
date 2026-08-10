- **The cross-lodge room listing no longer offers rooms at lodges the club has
  archived (#2727).** The booking API can list room configuration across every
  lodge a member is allowed to book. That listing left out inactive rooms and
  lodges the member is restricted from, but not lodges the club itself had
  archived — so a member could be shown rooms at a property that is closed,
  sold or shut for the season, and only find out when the booking was refused.

  Archived lodges are now left out of that listing, whether the member is
  unrestricted or restricted to a set of lodges that happens to include an
  archived one. Nothing an operator does changes: archive a lodge and it stops
  being offered.

  A compatibility note for anyone running a fork of this system: the listing is
  the older room lookup that does not name a lodge, and it is deliberately kept
  for external callers. If your own booking wizard or integration calls it, it
  will now receive fewer rooms back than before — only rooms at lodges that are
  still in service. Asking for one named lodge is unchanged, including for a
  lodge you have archived.
