- **Family Group screens now show a member's age when you are deciding about that
  specific person (#2568).** Two adults in one family group could look identical
  on screen — same surname, same shared email address, both tagged **ADULT** — so
  a 19-year-old and their 47-year-old parent were easy to mix up when linking,
  approving, creating or removing a member record.

  The member's calculated age now sits beside their name on exactly those
  screens: the suggested matches and member search on a pending request, the
  record picker and the **Selected member record** panel you confirm before
  approving, the requester and the person being added, the "create a new non-login
  adult / dependant" panels, the removal confirmation, the partner a **New Family
  Group** approval would invite, the member pills and search inside a group's
  editor, and each member row on **Family Suggestions**. It reads as `19 years`
  from five years old up, `3 years 8 months` below that, and `Age unavailable`
  when no usable date of birth is recorded.

  The ordinary Family Group list is unchanged, and so is every member-facing and
  public screen — those are routine views with no action attached to an individual
  member. The existing age-tier badge stays exactly where it was; the age sits
  beside it.

  Two things worth knowing. The age is worked out fresh every time you load the
  screen, on the New Zealand calendar date, so a birthday counts on the day —
  nothing is stored, because a stored age would be wrong the next morning. And it
  is worked out on the server: your browser is sent the age, not the date of
  birth, so a Family Group screen no longer carries a member's birth date at all.
  Only an admin with membership access sees it; an admin whose role covers an
  unrelated area is not sent it.

  The one date of birth still shown is the one the **requester typed** on a child
  or same-email adult request — the value you check a candidate record against —
  now with the matching age printed under it.
