- **An officer's edit of a member's record is now filed the same way whichever
  screen they used (#2755).** Every action the club records carries a category,
  and the category decides two real things: which permissions somebody needs
  before AI Diagnostics will show them the event, and whether the member the
  entry is about sees it on their own profile timeline.

  Editing, activating, deactivating or changing the roles of a member used to be
  filed **three different ways depending on which screen the officer opened**.
  Doing it to one member from their member page was filed under Admin; doing it
  to a selection from the bulk screen was filed under Account; and a bulk role
  change was filed under Security. So a search that should have returned the
  whole picture returned a third of it, with nothing to say that the rest was
  filed elsewhere. All three now file under **Admin**.

  **What a member will notice.** A member could see a bulk deactivation or bulk
  role change of their own account on their own profile timeline, and can no
  longer. They never saw the same act performed from the member page, so what
  actually changes is that the answer no longer depends on the officer's route.
  Making these entries visible to members *everywhere* was the alternative, and
  it is a bigger decision than tidying labels: it would publish an
  administrator's edits of somebody's record to that person, and audit entries
  are never rewritten, so it could not be undone afterwards. That decision is
  being taken deliberately and per kind of entry instead. **A member editing
  their own profile is untouched** — that stays under Account, on their own
  timeline, because it is the member's own action rather than an officer's.

  **What an operator will notice.** Bulk deactivations and bulk role changes now
  correlate in AI Diagnostics with Support access alone, where the bulk
  activate/deactivate half previously needed Membership access as well — the same
  access the member-page equivalent has always needed. Nothing became unreadable:
  every one of these entries is still in **Admin → Audit Log** for anyone with
  Support access, exactly as before. How long entries are kept has not changed.

  **One thing to expect when looking at older history.** This changed where new
  entries are filed and rewrote nothing already recorded, so bulk member entries
  from before this release are still found under Account and Security, and are
  still on the member's own timeline. Bulk member-record history is therefore
  split by date until that older data is revisited, the same way bed-allocation
  history has been since the previous release. The AI Diagnostics tools' own
  wording says this out loud, so a partial answer is never reported as a complete
  one.

  Two groups of settings that also record under Admin were re-examined and
  deliberately left there, with the reason now written into the club's invariant
  record rather than left in a closed discussion: the fifteen lodge-gated
  operational settings (chores, lockers, lodge instructions, lodge settings, the
  lodge records themselves and work parties), and lockers in particular, which
  remains genuinely undecided because its screens are gated on Membership rather
  than Lodge and a locker belongs to a named member.
