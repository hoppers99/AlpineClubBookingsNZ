- **The deploy safety gate now catches a renamed enum value, and a migration
  that genuinely needs a maintenance window can finally say so (#2288).** Before
  a risky database migration runs, the deploy checks its SQL for dangerous
  patterns and refuses to continue unless an operator explicitly overrides. Two
  holes in that check came to light while running a real migration against live
  data.

  The first: renaming a value inside a database list-of-options — a booking
  status, say, from `PENDING` to `REQUESTED` — was invisible to the gate. That
  rename is genuinely disruptive, because during a deploy the previous version
  of the site is still running and still sending the old name, which the
  database then rejects. A migration that only renamed such values sailed
  through as harmless. It is now caught and needs the same explicit
  acknowledgement as a dropped column — including when the statement is wrapped
  across two lines, and including a rename of the whole list rather than one of
  its values, neither of which the check could see. Adding a new option to the
  list is still treated as harmless, because it is, and so is renaming a
  database index.

  The second: the ledger row that documents each migration
  (`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`) had a column saying whether the
  previous version of the site keeps working — and the gate insisted the answer
  be "yes" for every risky migration, whether or not it was true. The column
  therefore said "yes" everywhere and told a reviewer nothing. It now accepts a
  third answer, `windowed`: *no, the previous version will break between the
  database change and the switch-over, and this is being deployed inside an
  announced maintenance window.* Saying `windowed` requires writing the
  incompatibility and the window plan into the same row, so it cannot become a
  quieter way of saying "yes", and anything other than the three accepted
  answers is now rejected instead of silently ignored — for **every** row in the
  file, not only the ones a deploy happens to look at. That distinction matters:
  most ledgered migrations trip none of the SQL patterns, so their answer was
  previously read by nobody, and typing `Windowed` instead of `windowed` would
  have quietly cancelled the maintenance window the operator wrote the row to
  demand. A duplicate row for the same migration is rejected for the same
  reason: only the first is ever read, and the shadowed one is exactly the
  `windowed` declaration two people racing on the same file would produce.

  For operators the override works exactly as it did — same flag, same required
  reason — but it is now demanded in two more places: a migration whose only
  risky statement is an enum-value rename, and any migration the ledger declares
  `windowed`. No migration already committed changes behaviour (the one that
  renames enum values was already caught for renaming columns too), so no
  existing upgrade path is affected.

  A `windowed` migration also moves the point of no return: with one of these,
  aborting after the database change no longer restores service, so the rollback
  plan starts at the migration step rather than at the traffic switch-over.
  `docs/BLUE_GREEN_MIGRATION_POLICY.md` and `docs/UPGRADING.md` spell that out,
  including taking the verified backup immediately before migrating and keeping
  a reverse script beside the migration — which the gate now insists on rather
  than merely asking for, so an operator can never reach that point and find the
  folder empty.

  Every existing ledger row stays valid; historical rows that would be written
  `windowed` today are left exactly as they were declared at the time. The
  policy describes how to recognise them as a class rather than listing them,
  because a list in a document goes stale and this one already had.
