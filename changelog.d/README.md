# Changelog fragments

Every pull request that changes application source writes its changelog entry
here, as **its own file**, instead of editing the top of `CHANGELOG.md`.

The reason is mechanical: when every branch edits the same few lines at the top
of `## Unreleased`, concurrent lanes conflict on that file every single day
(`AGENTS.md` §5, "Housekeeping that bites parallel lanes"). A new file per pull
request never conflicts. At release time the fragments are compiled into a real
version section and deleted.

The `CHANGELOG.md merge=union` declaration in `.gitattributes` (#2451) stays as
belt-and-braces through the transition, so the pull requests that still edit
`CHANGELOG.md` directly keep merging without a manual resolve.

## Adding a fragment

1. Create `changelog.d/<pr-number>-<short-slug>.md`, for example
   `changelog.d/2448-booking-request-tolerant-reads.md`. Any name works — the
   PR number simply keeps the release section in a sensible order — but the
   name must not be `README.md`, and the file must end in `.md`.
2. Write the entry exactly as it should appear in `CHANGELOG.md`: one or more
   top-level `- ` bullets in the house style below. Nothing else — no headings,
   no version number, no date.
3. Commit it with the rest of the pull request. The `verify` job checks that a
   code-bearing pull request carries one.

## The house entry style

An entry is written for a club administrator reading a release note, not for a
developer reading a diff. It opens with a **bold plain-English headline that
ends with the issue number in brackets**, then explains in ordinary sentences
what changed, what an operator will notice, and anything they must decide or do.
Continuation paragraphs are indented two spaces so they stay part of the bullet.

A worked example — `changelog.d/2448-booking-request-tolerant-reads.md`:

```markdown
- **A booking request no longer fails when the club's calendar is slow to
  answer (#2448).** Submitting a request used to give up the moment the
  availability lookup took longer than usual, and the member saw a generic
  error even though nothing was wrong with their request.

  The lookup is now retried briefly before the request is refused, and the
  message a member sees when it genuinely cannot be answered says so plainly
  and keeps what they had typed.

  Nothing about how availability is calculated changed — only how patiently
  the request waits for the answer.
```

Match the length to the change: a small fix is two or three sentences, a
behaviour change that operators must understand gets the fuller treatment above.
Read the last release section of `CHANGELOG.md` for the tone.

## When no entry is needed

Some code changes genuinely have nothing to tell a reader — a pure internal
refactor, a comment-only change, a test-seam tweak. Say so explicitly in the
pull request body by putting this marker on its own line:

```text
changelog: none — <one-line reason>
```

That is the same escape a docs-only pull request gets for free: pull requests
that touch nothing under `src/` or `prisma/` (outside test files) are never
asked for an entry at all.

The marker is deliberately **not** pre-filled into
`.github/pull_request_template.md`. A marker present in every pull request body
would switch the gate off for everyone.

## Compiling a release

From the release-prep branch (see `docs/MAINTENANCE.md`, "Public Reference
Release Checklist"):

```bash
node scripts/release/compile-changelog.mjs 0.14.0 --dry-run   # show the plan
node scripts/release/compile-changelog.mjs 0.14.0             # do it
```

The compiler adds `## <version> - <date>` above the existing releases, filled
with every fragment in filename order (numeric parts compared as numbers, so
`999-…` sorts before `2448-…`), folds in any entries still written directly
under `## Unreleased`, deletes the fragments it consumed, and prints what it
did. The date defaults to today in New Zealand; pass one as the second argument
to override it. Historical sections are never rewritten.
