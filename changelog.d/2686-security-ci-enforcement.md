- **The repository's secret scanner was switched off by its own config file, and
  is now on and blocking (#2686).** `.gitleaks.toml` did not extend the built-in
  rule set, and a gitleaks config that declares no rules of its own replaces
  that set rather than adding to it — so both secret-scanning jobs had been
  running against an empty rule list and passing unconditionally. Measured
  before the fix: a file containing an AWS access key, an AWS secret key and a
  live-format Stripe key scanned completely clean.

  The rules are enabled, and the whole repository history was re-scanned with
  them: **no real credential has ever been committed.** All 28 findings were
  synthetic — documented placeholder values, Stripe test keys, UUID fixtures and
  two sentences of prose the entropy heuristic disliked — and each is now
  suppressed either by a content-scoped allowlist that describes the exact value
  shape, or by a per-finding fingerprint with a written reason. The ten
  suppressions the repository used to carry were all dead: they named
  pull-request commits that no clone ever fetches.

  Secret scanning also now covers what its job name always claimed. The old
  "full repo" job scanned only the commits in the pull request, because the
  action it used picks its range from the event type; nothing had ever scanned
  the history. One job, `Secret scan (gitleaks)`, now scans both the pull
  request's own commits and all 5,061 commits of history, on one pinned version
  of the tool, and it must pass before anything can merge.

- **Three CI security gates now block a merge instead of only turning a job red
  (#2686).** `Secret scan (gitleaks)` and `Image security gate (Trivy CRITICAL)`
  join `Static analysis gate` as required checks on `main`. A CRITICAL
  vulnerability in the container image, or a leaked secret, now stops the merge.
  HIGH-severity image findings stay advisory and are reported alongside, clearly
  labelled, exactly as before.

  Making the image scan required cost no extra waiting: it used to be held back
  until the main test job had finished, about seventeen minutes into a run, and
  it now starts immediately and finishes well before the browser suites that
  already gate every merge.

- **Static analysis now knows two rules specific to this application (#2686).**
  Generic rule packs cannot know that a browser-side page must never import the
  database client, or that a hand-written SQL statement must never be assembled
  by pasting values into it. Both are now checked on every pull request, each
  with its own examples of what must fail and what must pass, so the rules
  cannot quietly stop working. The codebase was already clean against both.

- **CodeQL analysis was already running and is now written down (#2686).** It
  analyses the application and the workflow files on every push and pull request
  through GitHub's own configuration, and its findings are advisory: they are
  investigated but never block a merge. The documented list of checks that must
  pass before a merge now matches the settings actually applied to `main`, which
  it had drifted away from.
