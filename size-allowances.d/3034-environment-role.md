# File-size allowances for #3034 (ENV-SAFETY 1 — the environment role)

Five already-over-budget files grow here, and each gains one entry in a list or
one branch in a decision it already owns. None gains a new concern.

**`size-allowances.d/3000-club-time-zone.md` is deleted in this change**, and
that is required rather than tidying. Four of the five files below already
appear in it, and the gate refuses two allowances for one file — "one file, one
allowance". That file's own work merged some releases ago, so its lengths ARE the
lengths on the base ref and its entries have no remaining effect;
`size-allowances.d/README.md` says a merged allowance is inert, that merged files
"can therefore be swept from this directory in bulk at any time", and that
deleting one is safe. So it is swept here rather than edited — editing another
change's allowance to hold this change's numbers would make its stated lengths
untrue and put two branches back in the same file, which is the conflict this
whole one-file-per-pull-request pattern exists to end.

**The files this change actually invents are all well inside budget, and that is
the standard this list should be read against.** The resolver
(`environment-role.ts`, 435), its pure parser
(`environment-role-declaration.ts`, 143), the browser payload
(`environment-safety-admin-state.ts`, 239), the write path
(`environment-safety-override-write.ts`, 213), the withheld-email scaffold
(`environment-safety-withheld.ts`, 83) and the API route
(`environment-safety/route.ts`, 127 against a 250 route-handler budget) are new
modules carrying the whole of the new logic, so no size debt is created by this
feature. The route reached 270 once the review findings were folded in, and an
allowance is explicitly NOT available for a new file crossing its budget, so the
Serializable transaction and its audit row moved into
`environment-safety-override-write.ts` — the `src/app` authorises, `src/lib` does
the work split `docs/ARCHITECTURE.md` asks for anyway. That is what the escape
hatch is meant to look like from the outside: the split first, the allowance only
where the split is genuinely worse — only the five unavoidable registrations below.

file: src/lib/setup-readiness.ts
lines: 2159
reason: this is where a setup step is defined, and the seventeen already there
  are all in this file and assembled into the readiness report a few lines below
  them — the same argument #3000 made for the club-timezone step, which is the
  immediately preceding precedent. An eighteenth check in its own module would be
  the only one, splitting one contract across two places for the sake of a line
  count. Most of the growth is the wording rather than the logic: five states to
  distinguish, and each one has to say which of the two sources decided the
  answer, because an operator who repairs the wrong variable changes nothing and
  has no way to tell why. APP_RUNTIME_ROLE already exists, sits in the same
  Compose block, differs by one word, and holds the literal value "staging" on
  the staging stack, so every state names both variables explicitly. Review added
  the withheld-email line to the non-production branch — the one signal that
  separates a live club wrongly declared a copy from a copy nobody is using, and
  three renderable states because "none held back" and "not counted yet" look
  identical on a checklist and mean opposite things. A later round rendered that
  line for the UNDECLARED state too, which is the one a live installation reaches
  by upgrading without the declaration.

file: src/instrumentation.node.ts
lines: 1618
reason: a boot-time advisory has to be at boot, beside the four best-effort
  blocks already there (Sentry, the email-palette prime, the config self-heal,
  the ignored-email-env warning) — it is the fifth of a kind, not a new kind.
  The growth is mostly the comment explaining WHY it sits in the first
  `NEXT_RUNTIME === "nodejs"` block rather than at the end of `register()`: the
  second such block returns early when CRON_ENABLED is false, which is exactly
  what app_blue and app_green set, so an advisory appended at the end of the
  function would never run on the containers that serve traffic. That is a
  measured fact about this file and it belongs in this file. Review added the
  confirmed-copy branch beside the UNKNOWN one, and the measurement behind its
  log LEVEL: at warn, `measurement/current-main-refresh/bin/analyse-log-noise.mjs`
  counts the line eleven times and fails MC-09, because eight of that harness's
  producers recreate the app inside their own log-capture window.

file: src/lib/admin-permissions.ts
lines: 788
reason: the two new prefixes belong in `ROUTE_AREA_PREFIXES` beside the
  `/admin/club-time` and `/admin/backups` entries, which already state the same
  rule this one needs — area registration for the route map, Full Admin enforced
  in the route itself. Splitting that table would put one area's routes away from
  every other area's, which is the drift the route-map guard exists to catch.
  Review corrected the comment: reading the role is available at `support:view`
  through the setup checklist, and only the WRITE is Full-Admin-only, so the
  boundary is now stated as it actually is rather than one tier too narrow.

file: src/lib/member-merge.ts
lines: 3761
reason: twelve lines, and they are the price of the new schema column rather than
  of this feature's logic. `EnvironmentSafetySettings.updatedByMemberId` is an
  FK-less actor column, so `member-merge-dmmf.test.ts` fails until it is
  classified as a merge snapshot; the entry has to sit in that hand-kept list,
  beside the `ClubTimeSettings.updatedByMemberId` it is identical in kind to. The
  comment explains why the loser's id stays as immutable history — the question
  the next reader of that list will have — and why a member merge must not move
  this particular column at all: this row decides whether real members can be
  emailed.

file: src/components/admin-sidebar.tsx
lines: 1101
reason: the whole file is one declarative navigation table, and a menu entry
  cannot live anywhere else. The new item sits beside Access Roles, Export &
  Import and Club Time Zone because it shares their `fullAdminOnly: true` shape;
  the growth is that entry, its search keywords, and the comment saying why the
  page is Full-Admin while its permission area is `support`. The keywords are the
  words an operator would actually type — "staging", "test site", "copy", "live
  site" — none of which the label matches, and the command palette index is built
  from these entries.
