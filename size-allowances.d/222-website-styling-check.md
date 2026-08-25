# File-size allowances for #222

file: src/lib/setup-readiness.ts
lines: 2351
reason: adds buildWebsiteStylingCheck, the 19th step's readiness-check
  builder, following the exact same pattern as its eighteen siblings already
  in this file (buildStripeCheck, buildSentryCheck, buildEnvironmentRoleCheck,
  and so on) — one `build<Step>Check(db, progress): SetupStepCheck` function
  per registered step, wired into `buildSetupReadiness`'s `checksByCategory`.
  Splitting the checks out of this file is a real refactor this repository has
  deliberately deferred across every prior step addition (environment-role,
  #3034, grew the same file rather than starting a second convention); doing
  it as a side effect of a Low-risk, agent:sonnet child issue would widen #222
  well past its stated scope, and would leave the other eighteen builders
  behind in an inconsistent split. The natural seam — one file per check — is
  a genuine future refactor, tracked as a candidate rather than invented here
  under a single new step's PR.

file: src/lib/club-theme-schema.ts
lines: 956
reason: the #222 review (F3) made `setup-readiness.ts`'s website-styling
  check normalise a persisted theme before comparing it to the shipped
  defaults, using this module's already-exported `normaliseThemeValues`
  rather than duplicating its sanitisation rules a second time. The only
  change here is the doc comment on that function explaining the new external
  caller and why it exists — splitting `normaliseThemeValues` (or this whole
  schema module) out is a real refactor of its own, not something to invent
  as a side effect of documenting one more caller.
