# File-size allowances for #221

file: src/lib/setup-readiness.ts
lines: 2545
reason: CARRIED FORWARD FROM size-allowances.d/222-website-styling-check.md,
  which this change deletes. That file was spent when #222 merged — its
  club-theme-schema.ts entry then read as "an allowance the check did not
  need" and failed this gate for the next branch, and its setup-readiness.ts
  entry collided with the one below under the one-allowance-per-file rule. The
  gate's own instruction in both cases is to delete the entry, so #222's
  reasoning is restated here instead of being lost: it added
  buildWebsiteStylingCheck, the nineteenth step's readiness-check builder,
  following the exact pattern of its siblings. #221 adds buildLodgesCheck, the
  twentieth step's readiness-check builder,
  in the exact shape of its nineteen siblings already in this file
  (buildWebsiteStylingCheck landed the same way at #222, buildEnvironmentRoleCheck
  at #3034) — one `build<Step>Check(db, progress): SetupStepCheck` function per
  registered step, wired into `buildSetupReadiness`'s `checksByCategory`.
  Splitting the checks out is a real refactor this repository has deliberately
  deferred at every prior step addition, and doing it as a side effect of a
  gated lodge-availability change would widen #221 well past its stated scope
  while leaving the other nineteen builders behind in an inconsistent split.
  The natural seam — one file per check — remains a genuine future refactor
  rather than something to invent under a single step's PR. A large share of
  the growth is the builder's docblock, which carries the reasoning for the one
  editorial decision reviewers will want to check: why completeness here is
  activation rather than fullness. That reasoning belongs beside the derivation
  it explains.

file: src/app/(admin)/admin/lodges/[id]/setup/page.tsx
lines: 980
reason: the per-lodge setup flow gains its activation step — the affordance
  that makes #221's inactive-by-default creation usable at all. It is one
  handler plus its finish-step control, and it has to live inside this
  component: it reads and writes the same `lodge` state every other step here
  reads, and the finish step's own copy changes depending on whether the lodge
  is open. Lifting it out would mean threading that state through a prop pair
  for one button. The genuine split available in this file is a much larger
  one — six steps, each its own component — which this repository has already
  declined once here for a good reason (#2925's note on why the door-code
  belt-and-braces was NOT replicated into this file), and which is a refactor
  of its own rather than a side effect of adding the step the issue asks for.
