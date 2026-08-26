# File-size allowances for #223

CARRIED FORWARD FROM `size-allowances.d/221-lodges-step.md`, which this change
deletes — the same hand-over #221 performed on #222's file, and for the same
mechanical reason: one file may hold only one allowance, so an epic child that
grows a file a sibling already declared has to restate the sibling's reasoning
rather than add a second entry beside it. The two entries this change does not
alter are reproduced below unchanged in substance, because against `origin/main`
— the base the `verify` job's ratchet actually judges — this branch still
carries its siblings' growth, and deleting their reasoning would make the CI
base fail with no explanation on record. All of it goes inert the moment the
epic merges and the new lengths become the base ref.

NO ENTRY FOR `setup-page-client.tsx`, and that is deliberate rather than an
omission. C8's review round grew it past the 700-line ceiling for the FIRST
time, which no allowance may carry — correctly, since crossing a budget is the
moment to split rather than to declare. So it was split: the readiness cards
moved to `setup-readiness-checks.tsx` and the shared payload shape to
`setup-readiness-types.tsx`, both well inside the budget, and the page itself
came back to 491 LOC — below where it started. The split was available and
genuine: those cards render in exactly one branch of the legacy-surfaces
switch, so a hundred and fifty lines the hidden position never reaches were
sitting inside the component that chooses between the two.

file: src/lib/setup-readiness.ts
lines: 2599
reason: #223 adds the registry applicability filter to `buildSetupReadiness` —
  four lines of code, and the reasoning that keeps them safe. That reasoning is
  the three-state module contract (`undefined` fails open, `null` is the
  first-install defaults), which is the one thing a future `?? null` here would
  break silently, hiding setup work from the exact run that could not read the
  club's configuration; it belongs beside the expression it warns about. There
  is no seam to lift it to: everything above is the twenty individual check
  builders and this is the assembly at the foot of the file.
  #221's reasoning, still load-bearing against the CI base: it added
  `buildLodgesCheck`, the twentieth step's readiness-check builder, in the exact
  shape of its nineteen siblings — one
  `build<Step>Check(db, progress): SetupStepCheck` per registered step, wired
  into `buildSetupReadiness`'s `checksByCategory` — carrying forward in turn
  #222's `buildWebsiteStylingCheck` on the same pattern. Splitting the checks
  out is a real refactor this repository has deliberately deferred at every
  prior step addition; doing it as a side effect of a coexistence change would
  move about two thousand lines under a forty-line diff and put every other
  lane touching this epic watchpoint into conflict.

file: src/app/(admin)/admin/lodges/[id]/setup/page.tsx
lines: 981
reason: #221's, unchanged by this issue. The per-lodge setup flow gains its
  activation step — the affordance that makes inactive-by-default lodge
  creation usable at all. It is one handler plus its finish-step control, and
  it has to live inside this component: it reads and writes the same `lodge`
  state every other step here reads, and the finish step's own copy changes
  depending on whether the lodge is open. Lifting it out would mean threading
  that state through a prop pair for one button. The genuine split available in
  this file is a much larger one — six steps, each its own component — which
  this repository has already declined once here for a good reason (#2925's
  note on why the door-code belt-and-braces was NOT replicated into this file).

file: src/lib/club-theme-schema.ts
lines: 956
reason: #222's, carried forward twice now. The growth is
  `normaliseThemeValues` and its docblock, needed so the site-style step can
  compare a club's theme against the defaults without false positives. Epic
  children stack, so this branch still carries that growth relative to
  `origin/main` — the base the `verify` job's ratchet judges — while against
  the epic base the entry reads as unused. One PR cannot satisfy both bases
  with an earlier child's file present AND absent, so the entry stays here
  until the epic itself merges.

file: src/app/(admin)/admin/site-style/site-style-wizard.tsx
lines: 1049
reason: this page's "Finish setup" is the SECOND lever that publishes the public
  site, and #223 was asked to retire it with the legacy setup surfaces. The
  thirty-four lines are one prop, one four-line handler that saves without
  publishing, a two-line branch at the existing button, and the docblock stating
  why the button retires but the SAVE does not — which is the one thing a future
  reader would otherwise "simplify" back into a regression, because hiding the
  control outright looks tidier and silently removes the only way to persist the
  final step. The change has to be here: it reads the same `save()`, `saving`,
  `saveBlocked` and `setStep` state every other control in this component reads,
  and lifting the footer out would mean threading five values through a prop
  object for one branch. The real split available in this file is the same one
  its siblings have — five steps, each its own component — and that is a refactor
  of its own rather than a side effect of retiring a button.

file: src/lib/member-merge.ts
lines: 3769
reason: eight lines, and seven of them are a comment. INV-LIFE-078 requires every
  FK-less scalar member-id column in the schema to be enumerated here and
  classified as a snapshot or a live move, so the new
  `SetupSurfaceSettings.updatedByMemberId` has to be added to
  MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS or `member-merge-dmmf.test.ts` fails —
  that guard is exactly why this entry exists. The classification note sits
  beside the entry the way `ServerNzSettings.updatedByMemberId`'s does, because a
  list of bare strings with the reasoning somewhere else is how two of these
  columns escaped both the relation walk and the documentation in the first place
  (#2243). There is no split to make: the list must be one list.
