- **The domain rules now have permanent identifiers, and an agent no longer has
  to read 270,000 tokens of documentation before it can start (#2691).** The
  single 7,135-line "Domain Invariants" document has been split into one file per
  domain, with every rule carrying a permanent identifier such as `INV-CAP-021`
  that will never be renumbered or reused. `docs/DOMAIN_INVARIANTS.md` is now an
  index: every identifier with a one line description of what it covers and which
  file it lives in, so a rule can be found without reading the whole document. No
  rule was reworded, added or removed — this is a restructure only.

  The instruction list every automated agent reads first has been rewritten to
  match. It used to name nine documents, together about 270,000 tokens, which does
  not fit in a 200,000-token context window at all; in practice agents skipped it,
  and four consecutive changes each re-fixed a date rule that was already written
  down correctly. It is now a small always-read core plus a routing table —
  "changing capacity? read `INV-CAP` and `docs/CAPACITY_MODEL.md`" — measured at
  under 30,000 tokens. Nothing was deleted: the other documents are still
  authoritative and are still required reading when the row that names them
  applies.

  Four of the repository's own structural checks and its five custom code rules
  now name the identifier they enforce in their failure message, so a developer
  or agent who trips one is handed the rule instead of having to go and find it.

  A new check, `npm run docs:indexcheck`, runs in continuous integration and
  keeps both halves honest: every page under `docs/` must be reachable by
  following links from a front door, every quoted identifier must resolve to a
  real rule, and every rule must appear exactly once in the index. Four
  documentation pages that nothing linked to — a Codex profile example, two
  decision records and the approved lobby-display snapshots — are now linked from
  their nearest hub.

  The longest rule left in that core — how an admin settings screen is built,
  staged Edit → Save/Cancel, view-only gating, and the counts behind them — has
  moved out of it as well (#2714). `docs/ARCHITECTURE.md` already carried the
  same rules in fuller form, so what were two copies free to drift apart are now
  one, and the always-read instructions keep a pointer and a routing row that
  fires as soon as somebody is about to add a single toggle to a settings page.
  Nothing was reworded: the four clauses `docs/ARCHITECTURE.md` did not already
  state were carried across word for word, and the published control counts were
  re-measured against the code rather than copied.

  Everything that referred to the old single document has been re-pointed at the
  file that now holds the rule. That includes twenty-one links from the operator
  and member guides — six of which are published to the club wiki, where "see the
  payment and settlement rules" used to land a reader on a table of one-line
  summaries — and the reading instruction in six agent prompts, which now says to
  open the index *and* the rule files it routes to.
