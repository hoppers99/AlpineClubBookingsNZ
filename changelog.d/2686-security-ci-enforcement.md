- **The repository's secret scanner was switched off by its own config file, and
  is now on, and it can finally see the commits this project actually makes
  (#2686).** `.gitleaks.toml` did not extend the built-in rule set, and a
  gitleaks config that declares no rules of its own replaces that set rather
  than adding to it — so both secret-scanning jobs had been running against an
  empty rule list and passing unconditionally. Measured before the fix: a file
  containing an AWS secret key and a live-format Stripe key scanned completely
  clean.

  Turning the rules on was not enough on its own. `git log`, which gitleaks
  drives, emits no patch for a **merge commit** — and this project merges with
  merge commits by house rule, so 2,278 of the 7,507 commits on `main`, about
  thirty percent, had never been looked at by anything. A secret written into a
  file *while resolving a merge conflict* exists only in that merge commit, and
  was invisible. The scan now passes `--diff-merges=first-parent`, which sees
  them, and adds a third scan of the checked-out files so present-tense content
  is covered whatever shape history took.

  The whole of `main`'s history was then re-scanned with the rules on and the
  merge commits included. **Nothing that the scanner recognises as a credential
  has ever been committed to `main`.** Every finding was one of fifteen
  synthetic values — documented placeholders, Stripe test keys, two UUID test
  fixtures, a signed test JWT, and two sentences of prose the entropy heuristic
  disliked — and each is now forgiven by an allowlist naming that **exact
  string**, so it can hide nothing else. The claim is bounded by what the rules
  detect: a credential in a shape no rule matches would not have been found.

  The suppressions the repository used to carry were all dead. Ten named
  pull-request commits no clone ever fetches; the nine that replaced them were
  pinned to the wrong commit or the wrong line and suppressed nothing either —
  removing the file entirely changed no result. `.gitleaksignore` is now empty,
  and its header explains why a fingerprint cannot be durable once merge commits
  are scanned.

- **The scanner learned the leak this repository would most regret (#2686).**
  gitleaks has no built-in rule for a database connection string, so
  `postgresql://user:<password>@host/db` was undetected. On a public repository
  that is the most damaging plausible leak available, because the URL carries the
  host as well as the credential. A repository-owned rule now catches it, tuned
  against the several hundred local development connection strings in this
  repository's docs, Compose files and CI configuration so that none of them
  reports.

- **Every security gate now proves it can fail before it is trusted to pass
  (#2686).** Three separate times this repository has had a security check that
  was green because it was broken, which is indistinguishable from green because
  the code is clean. A failure-injection step now runs ahead of the real scans:
  it plants a credential and requires the scanner to report it, plants this
  repository's own development connection strings and requires it to stay quiet,
  and builds a four-commit repository whose merge resolution is a live-format key
  and requires that to be caught too. The custom static-analysis rules have the
  same treatment, and a test now asserts their examples still exist — the
  examples runner exits successfully when they have simply been deleted.

- **Two more CI security gates are set to block a merge instead of only turning
  a job red (#2686).** `Secret scan (gitleaks)` and
  `Image security gate (Trivy CRITICAL)` join the required checks on `main`.
  Applying that to branch protection is an owner action and is **not** done by
  this change: the two jobs are renamed here, so a branch that predates the merge
  cannot produce the new check names, and adding them early would freeze every
  open pull request on a status that never arrives. `AGENTS.md` records what is
  required today, what is pending, the order to do it in, and the command that
  reads the live configuration rather than trusting the document.

  Making the image scan blocking cost no extra waiting: it used to be held back
  until the main test job had finished, about seventeen minutes into a run, and
  it now starts immediately and finishes well before the browser suites that
  already gate every merge. `docs/MAINTENANCE.md` gains the break-glass for the
  day a new CRITICAL lands against the base image and reddens every pull request
  with nobody having changed a line.

- **Static analysis now knows two boundaries specific to this application
  (#2686).** Generic rule packs cannot know that a browser-side page must never
  reach the database client, or that a hand-written SQL statement must never be
  assembled by pasting values into it.

  Both rules are stricter than the first draft, because the first draft was
  measured. The SQL rule caught three of the thirteen ways this codebase writes
  that defect and missed the most natural one — build the string a line earlier
  and pass it by name — which is how the one permitted call in the application is
  written; it now requires the statement to be plainly visible at the call site,
  which is a closed condition rather than a list of tricks to enumerate. That
  found a second generated statement nobody had noticed, now documented in place.
  The boundary rule saw only plain imports, so a re-export or a lazily loaded
  module walked straight through; it now sees those, and covers the Node
  built-ins that matter here, including the cryptography one. A companion test
  walks the import graph transitively, which no single-file rule can do, and
  records the one indirect edge that exists today.

- **CodeQL analysis was already running and is now written down (#2686).** It
  analyses the application and the workflow files on every push and pull request
  through GitHub's own configuration, and its findings are advisory: they are
  investigated but never block a merge. The documentation also now states which
  of the two Semgrep scans each suppression in the codebase actually applies to
  — measured, exactly one of the eighty-eight applies to the one that can stop a
  merge.
