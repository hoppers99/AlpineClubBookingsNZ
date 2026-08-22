# File-size allowances for #3000 (CT-1, #2989 — club time zone)

Four already-over-budget files grow here. Each gains one entry in a list or one
branch in a decision it already owns — none of them gains a new concern.

**The one file that would have crossed its budget for the first time was split
instead**, which is the standard this list should be read against.
`src/lib/config-self-heal.ts` was **683 lines against a 700 budget** on
`origin/main` — seventeen lines of headroom, and an allowance is explicitly not
available for a first crossing. Its five step *definitions* moved to a new
`src/lib/config-self-heal-steps.ts` (417 + 518, both clear), re-exported from
their original module so no importer, no document and no schema comment had to
change. So the club-timezone backfill step carries no size debt at all.

file: src/lib/setup-readiness.ts
lines: 1731
reason: this is the change. The setup checklist gains a seventeenth step, and the
  sixteen already there are all defined in this file and assembled into the
  readiness report a few lines below them. A seventeenth check in its own module
  would be the only one, splitting one contract across two places for the sake of
  a line count. Roughly half the growth is the four-state decision written out
  where the next reader meets it — in particular why an absent row BLOCKS rather
  than warns on a fresh install, and why a missing snapshot refuses to answer
  from the environment instead of guessing.

file: src/components/admin-sidebar.tsx
lines: 1078
reason: the whole file is one declarative navigation table, and a menu entry
  cannot live anywhere else. The new item sits beside Access Roles and Export &
  Import because it shares their `fullAdminOnly: true` shape; the growth is that
  entry, its search keywords and the comment saying why the page is Full-Admin
  while its permission area is `support`.

file: src/lib/admin-permissions.ts
lines: 771
reason: the two new prefixes belong in `ROUTE_AREA_PREFIXES` beside the
  `/admin/backups` entry, which already states the same rule this one needs —
  area registration for the route map, Full Admin enforced in the route itself.
  Splitting that table would put one area's routes away from every other area's,
  which is the drift the route-map guard exists to catch.

file: src/lib/member-merge.ts
reason: nine lines, and they are the price of the new schema column rather than
  of this feature's logic. `ClubTimeSettings.updatedByMemberId` is an actor
  column, so `member-merge-dmmf.test.ts` fails until it is classified as a merge
  snapshot; the entry has to sit in that hand-kept list, next to the two sibling
  settings-audit columns it is identical in kind to. The comment explains why the
  loser's id stays as immutable history, which is the question the next reader of
  that list will have.
lines: 3750
