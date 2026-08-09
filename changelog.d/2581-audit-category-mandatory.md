- **The platform can no longer record an activity entry that nobody can find
  (#2581).** Every entry carries a category saying which part of the club it
  belongs to, and that category is not decoration: the AI Diagnostics assistant
  can only search by it, so an entry recorded without one is returned by none of
  the assistant's tools, to anybody, at any permission level — and it is also
  kept indefinitely, because the platform works out how long to keep an entry
  from its category.

  An earlier change in this same release gave all 82 of the places that were
  recording entries without a category one. What it did not do was stop the
  *next* one being written the same way. A developer adding a new kind of entry
  could still leave the category out; the only thing that would notice was an
  automated count, and only if it was run.

  **Leaving it out is now refused three ways.** It does not compile, so the
  mistake is caught before the code runs. If a category that is not one of the
  eleven reaches the moment of recording — a typo, an invented name, an empty
  value — the entry is refused rather than stored where no filter can reach it.
  And the automated count still runs on every build, for the two kinds of writer
  the first two cannot see: a database migration writing the table directly, and
  a maintenance script outside the normal path. The count itself was tightened
  too: six ways of slipping past it were found while this change was reviewed —
  all of them ways of writing to the table by a side door — and all six are now
  caught.

  **What an operator will notice: nothing, and that is the intended outcome.**
  No entry changed category, so nothing moved between the AI Diagnostics tools,
  the Admin → Audit Log Category filter, or a member's own activity list. No
  permission changed. Nothing became readable or unreadable to anybody. This
  change is about what the platform will accept when it records the *next*
  entry.

  **One old entry type stops being kept forever.** The record written when a
  young member ages up and the club emails their parent instead of them was
  being saved outside the platform's normal recording step, so nothing worked out
  how long to keep it — it had no expiry at all, and it names both the member and
  the email address the message went to. It now goes through the same step as
  everything else and expires **seven years** after the event, like every other
  entry of its kind. Records already written keep whatever they were written
  with; this applies to new ones.

  **One behaviour worth stating**, because it is a refusal rather than a
  warning: where a rejected entry is part of a change being saved — linking a
  dependant, approving a deletion request — the change is abandoned along with
  it. That is deliberate and is not new: the record and the change it describes
  have always succeeded together or not at all, and this is one more way the
  record can fail. Where an entry is recorded alongside an operation rather than
  as part of it, the operation continues and the problem is logged, exactly as
  before.

  **Entries recorded before all this still have no category** and are still
  invisible to AI Diagnostics. Filling those in is the last of the three changes
  and has not happened yet. Until it does, an empty AI Diagnostics result means
  "look in Admin → Audit Log", never "it did not happen".
