# The `INV-*` invariant scheme (issue #2691, phase 1)

Audience: Developer, Agent.

This is the phase 1 deliverable of #2691: the identifier scheme, the per-domain
file list, and one section fully worked as a specimen
([`booking-dates-and-capacity.md`](booking-dates-and-capacity.md)). Nothing else
in `docs/DOMAIN_INVARIANTS.md` has been touched. Phase 2 does the other
fourteen files against this scheme, and does not start until this is accepted.

Once accepted, this file's permanent home is `docs/invariants/SCHEME.md` (rename
at phase 4, linked from the index). The leading underscore marks it as a phase 1
artifact that has not yet been wired into the index.

---

## 1. What an `INV-*` ID is

An ID is a **permanent public identifier for one rule**, in the same sense that a
database primary key is permanent. It will be cited from places this repository
cannot rewrite: merged commit messages, closed issues, PR bodies, lint failure
strings shipped in a release, test names in a fork, and a club's own operating
notes. Treat it accordingly.

### 1.1 Form

```
INV-<PREFIX>-<NNN>
```

- `<PREFIX>` — uppercase letters and digits, starting with a letter. Names a
  durable area of the system.
- `<NNN>` — exactly **three digits, zero-padded**, from `001`.

Examples: `INV-DATE-001`, `INV-CAP-029`.

**Three digits, not two.** The issue body illustrates the shape with two digits:

```
INV-MONEY-01   INV-CAP-07   INV-DATE-03      <- illustrative only, not adopted
```

Two digits caps a prefix at 99
rules for all time, and because IDs are never renumbered the width can never be
widened later without either breaking every existing citation or leaving two
IDs that differ only by a leading zero. Three digits costs one character and
removes the problem permanently. **This is the one place this scheme differs
from the issue body's illustrative text** — flagged for the owner in §11.

### 1.2 A prefix names a durable area, not a feature

Renaming a prefix renumbers everything under it, which is forbidden, so a
prefix is as permanent as the numbers beneath it. Choose one you could still
justify if the feature it currently holds were deleted tomorrow. When in doubt,
choose the **coarser** prefix: a coarse prefix can be narrowed later by giving a
new area its own prefix and leaving existing IDs exactly where they are, whereas
a prefix that turns out to be wrong can never be fixed.

Two consequences worth stating plainly:

- `INV-LOCK` is not used for subscription lockout, because this codebase's
  "lock" means an advisory row lock. Ambiguity in a permanent key is a defect.
- An ID's prefix is a **key, not a description**. Over time some rules will sit
  under a prefix that no longer describes them perfectly. That is correct and
  expected; the index, not the prefix, is authoritative for what a rule covers
  and where it lives.

### 1.2.1 The `INV-` namespace is already occupied — reserved prefixes

This repository already writes `INV-…` strings, in quantity: they are **Xero
invoice numbers** in test fixtures. A scan of every tracked file found 68
distinct `INV-` tokens, and four of them match the invariant citation shape
exactly:

```
INV-IB-001   INV-SETTLE-001   INV-SETTLE-002   INV-SUP-001
```

`INV-XERO`, `INV-FAM`, `INV-LEGACY`, `INV-PM`, `INV-SUB-2026-001` and about
sixty others are close enough to matter for the future even though they do not
match today.

Three consequences, all load-bearing:

1. **These prefixes are reserved and must never be used as invariant prefixes:**
   `IB`, `SETTLE`, `SUP` (the three that collide today), plus `SUB`, `XERO`,
   `FAM`, `LEGACY`, `PM`, `JOR`, `REB` (the near-misses). The enforcement check
   carries this list explicitly — see §8.
2. **`INV-XERO` is therefore not used** for the Xero member-grouping rules; they
   take `INV-INT` alongside the rest of Integrations. A prefix that a Xero test
   fixture could plausibly write tomorrow is not a safe permanent key.
3. **The failure mode is loud, not silent**, which is why `INV-` is still
   adopted rather than abandoned. If someone later writes a fixture invoice
   under a real invariant prefix, the check reports an unresolved invariant
   citation and the author renames the fixture or allowlists it. It cannot
   silently mis-resolve.
   The alternative — a fresh namespace such as `ACB-CAP-007` — removes the
   collision entirely but departs from the issue's stated `INV-*` scheme; it is
   put to the owner in §11 rather than taken unilaterally.

### 1.3 Allocation

1. **At the restructure (phase 2 only):** within each prefix, numbers are
   assigned in source-document order, starting at `001`, incrementing by one,
   with no gaps. This is the only moment at which number order and document
   order agree.
2. **Afterwards:** a new invariant takes `max(existing number in that prefix) + 1`
   and is **placed in the file wherever it belongs to a reader** — which will
   usually not be at the end. Number order and file order diverge immediately
   and permanently. That is intended, not a defect to be tidied.
3. **A number is mutable only until it first merges to `main`.** Two lanes that
   independently pick the same next number collide; the phase 4 check fails the
   PR on the duplicate definition, and whichever PR lands second simply
   renumbers — it is renumbering an ID nothing has cited yet, which is free.
   After merge, never.

### 1.4 The no-renumber rule

> **An `INV-*` ID, once merged to `main`, is never renumbered, never reused, and
> never deleted.**

- **Never renumbered.** Not to close a gap, not to restore document order, not
  to make a file read better. A renumber silently re-points every existing
  citation at a *different rule* — in code comments, test names, lint messages,
  closed issues and other forks. That is the same class of failure this
  restructure exists to prevent: a rule that is written down correctly and still
  does not hold, because the pointer to it went stale.
- **Never reused.** A retired number is burnt. Reuse makes an old citation
  resolve, wrongly, to an unrelated rule — worse than failing to resolve.
- **Never deleted.** A rule that is superseded keeps its heading and gains a
  status line directly beneath it:

  ```
  ### INV-CAP-013

  **Superseded by INV-CAP-041 (PR #NNNN).** <original text kept below, verbatim>
  ```

  A rule that is genuinely obsolete keeps its heading and gains
  `**Retired (PR #NNNN): <one-line reason>.**` in place of its body. Either way
  the ID still resolves, so the phase 4 check still passes for old citations,
  and a reader who follows a stale pointer is told what happened instead of
  landing on nothing.

**Moving and splitting.**

- A rule that **moves to another file keeps its ID and its prefix.** Files are a
  presentation layer; the index is authoritative for ID → file. A move is a
  one-line index edit.
- A rule that is **split** keeps its ID for the part that retains the original
  meaning; the new part takes a fresh number. Never `INV-CAP-013a`, never
  `INV-CAP-013.1`.
- A rule that is **merged** into another keeps both IDs: the absorbed one becomes
  a `Superseded by` stub pointing at the survivor.

### 1.5 Prefix ↔ file

> **A prefix lives in exactly one file. A file may host more than one prefix.**

One-to-many in that direction only. `INV-DATE` and `INV-CAP` share
`booking-dates-and-capacity.md` because their rules refer to each other
positionally ("the stay-boundary invariant above"), and splitting them would
require editing navigational prose (§4). Splitting a *prefix* across two files
is never done, because the whole point of a prefix is that "load `INV-CAP`" is a
single file read.

---

## 2. What gets an ID: the block rule

An ID names a **block**, not a sentence. Walking the source document top to
bottom, a new block starts at:

- a **top-level list item** (`- ` at column 0), taking with it every nested item
  and every continuation paragraph indented beneath it, up to the next
  column-0 list item or the next heading; **except** that
- a **paragraph ending in a colon that introduces a list** binds that whole list
  into one block with it (the bullets are grammatically a continuation of the
  sentence — "Google Analytics must not load unless ALL of the following hold:"
  means nothing split from its four conditions); and
- a **paragraph, table, blockquote or fenced block at column 0** that is not part
  of the preceding block.

Headings and blank lines start no block; they are structure.

**Blocks are never split mid-bullet.** A 149-line bullet gets one ID (see
`INV-CAP-010`). Splitting it would mean inserting a heading inside a list item,
which breaks the list, re-indents the prose, and forces every line to be
re-wrapped — precisely the churn that hides a changed word. Where a block is
uncomfortably large, that is recorded as a candidate for a *later, separate*
issue, which can split it into new IDs without renumbering anything (§1.4).

### 2.1 Normative versus non-normative

Phase 3 audits against this rule, so it is stated exactly.

A block is **normative** if it contains at least one sentence that:

- **(a)** says what the system must, must not, always or never do; or
- **(b)** states, in the present tense, a property the code, schema or data
  currently guarantees and which a change could break — "Capacity is per lodge",
  "A booking belongs to exactly one lodge"; or
- **(c)** constrains a *future change* rather than the system — "do not add a
  hard block without a fresh owner decision", "never a side effect of work in
  this area", "fold restatements you find into references"; or
- **(d)** names the single source of truth or the chokepoint for a rule — "the
  implementation source of truth is `capacityHoldingBookingFilter()`".

A block is **non-normative** only if *every* sentence in it is (i) rationale for
why a normative rule exists that adds no obligation of its own, (ii) a worked
example or incident history whose removal changes no obligation, or (iii)
navigation text.

**The tie-break is deliberately asymmetric: if you cannot decide, it is
normative.** A non-normative block wrongly given an ID costs one index line. A
normative block wrongly left without one is the failure this restructure exists
to prevent.

### 2.2 The property that actually protects phase 3

Classification is the weakest link in any migration like this, so the scheme is
built so that **classification cannot lose anything**:

> **Every block gets an ID, normative or not, and every block moves. Nothing is
> classified away.**

Non-normative rationale travels with its block, under its block's ID. The only
source text that does *not* end up inside an ID'd block is: the document's own
four-line preamble, the `##`/`###` headings, and blank lines.

That converts phase 3's job from a judgement call ("is this normative?") into
line accounting ("is every line present?"), which is checkable. §3 makes it
mechanical.

---

## 3. The only three edits phase 2 may make

This is the transcription discipline, and it is exhaustive. Anything not on this
list is a rewrite and is forbidden.

1. **Insert an ID heading line** (plus one blank line either side) before a
   block.
2. **Append a bracketed ID pointer** immediately after a positional
   cross-reference whose target has left the file — ` [INV-CAP-004]`. Nothing is
   deleted and no existing word is changed; a pointer is *added* beside the word
   that no longer navigates. Every such insertion goes in the PR's pointer
   register (§4.2).
3. **Change the path half of a relative Markdown link** when the link's target
   moved relative to the new file — `](TESTING.md)` → `](../TESTING.md)`. The
   fragment is never touched.

Heading *levels* change (a source `###` becomes a `##` in its own file) but
heading *text* never does.

### 3.1 The reconstruction check

Because that list is exhaustive, the destination is mechanically reducible to
the source:

> Take the destination files. Drop the front-matter block above the first `##`.
> Drop every line matching the ID-definition regex. Undo the `../` path edits and
> the ` [INV-*]` pointer insertions listed in the register. Restore heading
> levels. Concatenate in index order. **Every non-blank line must be
> byte-identical to the source, in order, and the word count must match exactly.**

Blank-line runs are the one permitted difference, because an ID heading needs a
blank line either side and the source runs consecutive bullets with none.

This was run against the specimen and passes:

```
non-blank lines: source 851  specimen 851
BYTE-IDENTICAL (non-blank lines)
source words 8686  specimen words 8686
```

Phase 3 should run this per file before doing anything else. A reviewer's
reading time is then spent only on what the check cannot see — whether the
*right* text landed under the *right* ID, and whether a block was dropped
wholesale rather than altered.

---

## 4. Cross-references and inbound links

### 4.1 Inbound links from other documents

27 links elsewhere in the repository point into `docs/DOMAIN_INVARIANTS.md` with
an anchor, and about 70 files reference the path without one. The scheme keeps
almost all of them working for free by **keeping the index at
`docs/DOMAIN_INVARIANTS.md`** (§6):

| Inbound link shape | Count | What phase 2 does |
| --- | --- | --- |
| `DOMAIN_INVARIANTS.md` with no anchor | ~70 | **Nothing.** The path still resolves — to the index. |
| Anchor to a top-level section (`#money`, `#membership-lifecycle`, `#payment-and-settlement`, `#booking-dates-and-capacity`, `#analytics-and-privacy`) | 21 | **Nothing.** The index keeps those nine `##` headings with byte-identical text, so the slugs are unchanged. |
| Anchor to a subsection (`#the-stay-boundary-midday-nz-to-midday-nz-normative` ×4, `#member-profile-merge-e11-1937`, `#xero-member-grouping-e8-1934`) | 6 | **Change the path only, keep the fragment.** The subsection heading moves verbatim into its domain file, so the slug is unchanged. |

No redirect stubs are left behind. A stub is a second place a reader can land
and find nothing, which is the failure mode being fixed.

New citations should prefer the ID anchor —
`[INV-CAP-021](invariants/booking-dates-and-capacity.md#inv-cap-021)` — which
`npm run docs:linkcheck` validates against the real heading.

### 4.2 Positional cross-references inside the document

The document navigates itself with "above", "below", "the invariant above", "its
own section below" and "this subsection" — roughly 80 occurrences. Rules, in
order:

1. **If the target stays in the same file, in the same relative position, leave
   the sentence alone.** This covers the large majority, and is the main reason
   file boundaries follow the document's existing heading zones (§5).
2. **Where a pointer would cross a new file boundary, prefer moving the
   boundary** — keep the two parts in one file — over touching the sentence.
3. **Only where (2) is impossible**, append the bracketed ID pointer of edit
   type 2. Illustration, using the specimen's own case (source line 458, whose
   target is in Membership Lifecycle):

   ```
   before:  - The custodian bed hold uses deliberate inclusive day semantics (its own
              section below): an assignment's `endDate` is a covered day, not a
              departure morning.

   after:   - The custodian bed hold uses deliberate inclusive day semantics (its own
              section below [INV-LIFE-0NN]): an assignment's `endDate` is a covered
              day, not a departure morning.
   ```

4. **Every insertion is registered.** The PR body carries a table of
   `source line → inserted pointer`, and nothing else in the diff may add text.

**The pointer register phase 2 already owes** (found in phase 1; phase 2 must
re-derive the full list, this is not claimed to be complete):

| Source | Positional phrase | Target | Crosses a file boundary? |
| --- | --- | --- | --- |
| 458–459 | "its own section below" | custodian bed hold, 6828–6888 | **Yes** — reciprocal with 6838–6840 |
| 6838–6840 | "the stay-boundary invariant in 'Booking Dates And Capacity' names deliberately" | 455–459 | Names the section by title — survives, no edit |
| 5125 | "rule (b) above" | capacity-holding rule, 619–633 | **Yes** |
| 5150–5151 | "The capacity-priority rule above" | 619–633 | **Yes** |
| 4823 | forward reference to the reason-agnostic check-in block | 5090–5091 | **Yes** |
| 4955 | "a finished stay belongs to the queue above" | 4509–4513 | **Yes** |
| 5053 | "the uncollected delta counts on the second queue above" | 4514–4531 | **Yes** |
| 5829–5831 | "see the member-guest consent cluster above" | § line 2146 | **Yes** |
| 6075–6082 | "see 'Member-Guest Consent'" | § line 2146 | Names the section by title — survives |
| 2390, 2665, 3919, 5057 | "the stay-boundary invariant in 'Booking Dates And Capacity'" | 354 | Names the section by title — survives |
| 6292 | "#2424 (above)" | 6480–6519, which is **below** | Already wrong in the source — see §10 |

---

## 5. The per-domain file list

### 5.1 What the document's structure actually is

The issue names nine top-level sections. That matches the file, but two facts
about the real structure change the file plan and should be stated before it:

- **The sections are wildly uneven and three of them are catch-alls.**
  "Booking Modifications" is 3,069 lines under one heading, of which only about
  900 are genuinely about mutating an existing booking; the rest is hosting
  policy, subscription-lockout pricing, email/notification policy, account
  deletion, Xero reconciliation, booking requests and admin queues that accreted
  under the nearest heading. "Payment And Settlement" (931 lines) has no
  subheadings at all. "Membership Lifecycle" has 1,382 consecutive lines with no
  subheading.
- **Two `###` headings stop describing their content partway through.**
  `### Subscription-lockout booking pricing (#2533)` runs to line 4541 but stops
  being about subscription lockout at line 3902; `### Chasing an outstanding
  additional payment (#2350)` runs to 5427 but stops at 5040.

**The file plan follows the document's own headings anyway, and does not
re-domain anything.** Re-filing 2,000 lines into their "true" domains is a
semantic reorganisation with real risk of loss, it invalidates dozens of
positional cross-references at once, and it is not what the issue asked for.
The mis-filing is recorded in §10 as a candidate for a separate issue.

### 5.2 The files

Index: **`docs/DOMAIN_INVARIANTS.md`** (unchanged path). Domain files:
**`docs/invariants/`**.

| # | File (`docs/invariants/`) | Prefix(es) | Source lines | Lines | ≈tokens | Read it when you are changing… |
| --- | --- | --- | --- | ---: | ---: | --- |
| 1 | `public-content.md` | `INV-PUB` | 6–15 | 10 | 0.1k | public fee/policy page content and lodge tokens |
| 2 | `money.md` | `INV-MONEY` | 16–351 | 336 | 4.9k | anything holding cents: fee authorities, whole-lodge pricing, promo caps |
| 3 | `booking-dates-and-capacity.md` **(specimen)** | `INV-DATE`, `INV-CAP` | 352–1214 | 863 | 12.6k | what day it is, who is present, how many beds, which bed |
| 4 | `payment-and-settlement.md` | `INV-PAY` | 1215–2145 | 931 | 14.5k | taking, clearing, crediting or refunding money |
| 5 | `member-guest-consent.md` | `INV-GUEST` | 2146–2358 | 213 | 3.4k | a member bringing a guest, and consent to do so |
| 6 | `booking-modifications.md` | `INV-MOD` | 2359–2786 | 428 | 6.4k | editing an existing booking's dates, party or price |
| 7 | `adult-member-hosting.md` | `INV-HOST` | 2787–3359 | 573 | 8.6k | who may host whom, and what strands cover |
| 8 | `booking-requests.md` | `INV-REQ` | 3360–3476 | 117 | 1.8k | booking-request notes and the member's own request area |
| 9 | `subscription-lockout-pricing.md` | `INV-LOCKOUT` | 3477–4541 | 1,065 | 16.0k | lapsed-subscription pricing, admin overrides, notification withholding |
| 10 | `booking-policy-exceptions.md` | `INV-EXCEPT` | 4542–4914 | 373 | 5.6k | policy-exception requests and officer decisions on them |
| 11 | `additional-payment-chasing.md` | `INV-ADDPAY` | 4915–5427 | 513 | 7.7k | an outstanding additional payment and who chases it |
| 12 | `analytics-and-privacy.md` | `INV-PRIV` | 5428–5505 | 78 | 1.0k | analytics, consent banners, what leaves for Google |
| 13 | `membership-lifecycle.md` | `INV-LIFE` | 5506–7111 | 1,606 | 23.6k | applications, cancellation, family groups, merge, custodian holds |
| 14 | `integrations.md` | `INV-INT` | 7112–7180 | 69 | 0.9k | webhooks, cron idempotency, Xero member grouping |
| 15 | `operations.md` | `INV-OPS` | 7181–7224 | 44 | 0.6k | raw SQL, deployment, what may be used as test input |

15 files, 16 prefixes, ~350–400 IDs. The two large files (#9 at 16k, #13 at 24k)
are kept whole deliberately: splitting either would require inventing headings
the source does not have, and would break six and roughly fifteen internal
positional pointers respectively. Both are named in §10 as split candidates for
a later issue.

### 5.3 Token budget

| | ≈tokens |
| --- | ---: |
| `docs/DOMAIN_INVARIANTS.md` today (mandatory read #6 of nine) | **108k** |
| Largest single domain file after the split (`membership-lifecycle.md`) | 24k |
| Typical domain file | 1–9k |
| The index, whole (routing table + full ID catalogue) | **~8k** |

The mandatory preamble phase 4 has to fit under 30k:

| | ≈tokens |
| --- | ---: |
| `AGENTS.md` (7,058 words) | 10.2k |
| `CLAUDE.md` (1,617 words) | 2.3k |
| `docs/README.md` — the hub (2,424 words) | 3.5k |
| `docs/agents/CODEX_WORKFLOW.md` (1,550 words) | 2.2k |
| `docs/DOMAIN_INVARIANTS.md` — the index | 8.0k |
| Routing table (inside `AGENTS.md`) | 1.0k |
| **Total** | **~27k** |

That clears 30k, but not by much, and it assumes the other five current
"Read First" documents (`CONFIGURATION.md`, `ARCHITECTURE.md`,
`STATE_MACHINES.md`, `END_TO_END_TEST_MATRIX.md`, `UX_FLOW_MAP.md` — 173k
tokens between them) move from *mandatory* to *routed*. If phase 4 measures over
budget, the cheapest lever is to move the full ID catalogue out of
`docs/DOMAIN_INVARIANTS.md` into `docs/invariants/ID-INDEX.md`, leaving the
routing table as the mandatory read. That alone drops ~7k and still satisfies
"find the right file without opening more than one other file". Keeping it in one
file is preferred while it fits.

---

## 6. The index

**The index stays at `docs/DOMAIN_INVARIANTS.md`.** It is not moved to
`docs/invariants/README.md`, for one reason that outweighs directory tidiness:
about 70 files — including `AGENTS.md`, `CLAUDE.md`, `README.md`, nine
`docs/guides/` pages, thirty source files and the Codex skills — already point
at that path, and 21 of the 27 inbound anchors are to headings the index keeps
verbatim. Moving it would turn a free migration into ~97 edits and a permanent
fork-compatibility break, and would gain nothing a reader can feel.

`docs/invariants/` therefore has no `README.md`; the phase 4 reachability check
treats `docs/DOMAIN_INVARIANTS.md` as the root of the invariants tree.

### 6.1 Index skeleton

```
# Domain Invariants

<the source's existing four-line preamble, verbatim>

## How to use this index          <- new: the routing table, ~40 lines
## How IDs work                   <- new: 6 lines + link to SCHEME.md

## Public authoritative content   <- the nine source H2 headings, byte-identical text
## Money
## Booking Dates And Capacity
## Payment And Settlement
## Member-Guest Consent
## Booking Modifications
## Analytics And Privacy
## Membership Lifecycle
## Integrations
## Operations
```

Under each of the nine domain headings: one sentence of what it covers, the
file(s) it lives in with their prefixes, and a table of every ID in it with a
one-line (**≤ 12 words**) description. The word cap is load-bearing — it is what
keeps the index inside the token budget in §5.3.

A domain whose content is split across several files (Booking Modifications →
files 6–11) lists each file under the same `##` heading, so the inbound anchor
`#booking-modifications` still lands on something that routes correctly.

### 6.2 The specimen's index rows

Exactly what phase 2 produces for the other fourteen files:

**Booking Dates And Capacity** — what a lodge night is, who is present on a day,
how many beds a lodge has, and which bed a guest gets.
File: `invariants/booking-dates-and-capacity.md` (that is the path as written *from
the index*; from this file it is [`booking-dates-and-capacity.md`](booking-dates-and-capacity.md)).
Prefixes `INV-DATE`, `INV-CAP`.

| ID | Covers |
| --- | --- |
| `INV-DATE-001` | The stay boundary is stated once here; reference it, never restate it |
| `INV-DATE-002` | Night N runs midday NZ on date N to midday NZ on date N+1 |
| `INV-DATE-003` | A stay is the half-open range `[checkIn, checkOut)` expanded to nights |
| `INV-DATE-004` | Presence on day D: morning half from D−1's night, evening half from D's |
| `INV-DATE-005` | Two helper families — night model for resources, operational-day for people |
| `INV-DATE-006` | The lobby wall is deliberately mixed and stays on its own fenced path |
| `INV-DATE-007` | Departing lodge A and arriving at lodge B on one date is legal |
| `INV-DATE-008` | Zero-night bookings expand to no nights and every route refuses them |
| `INV-DATE-009` | Six areas sit deliberately outside the boundary and must not be aligned |
| `INV-DATE-010` | `@db.Date` holds an NZ calendar date; UTC midnight is encoding, not meaning |
| `INV-DATE-011` | Lodge bookings use NZ date-only nights, not arbitrary timestamps |
| `INV-DATE-012` | `BookingGuest.stayStart`/`stayEnd` are date-only occupancy in the envelope |
| `INV-DATE-013` | Compare date columns only against date-only values, never a raw clock |
| `INV-DATE-014` | Client-side a lodge night is an NZ `yyyy-MM-dd` string, carried end to end |
| `INV-DATE-015` | Rendering has one seam, `nzst-date.ts`; bare `toLocale*` is lint-blocked |
| `INV-DATE-016` | `formatNZLongDate` is reserved for four named member-facing surfaces |
| `INV-DATE-017` | Two check-out boundaries coexist: completion `<` today, queues `<=` today |
| `INV-DATE-018` | Base Reports uses lodge nights, one positive cohort, cents-exact allocation |
| `INV-CAP-001` | Capacity is per lodge; no path may sum beds across lodges |
| `INV-CAP-002` | `lodgeId` is NOT NULL on six tables via a default-lodge column default |
| `INV-CAP-003` | `getLodgeCapacityStatus` resolves capacity; an explicit capacity caps beds |
| `INV-CAP-004` | `capacityHoldingBookingFilter()` decides which bookings consume beds |
| `INV-CAP-005` | A split guest portion always settles or is notified, never stranded |
| `INV-CAP-006` | Bed-allocation eligibility is a status-only superset of capacity-holding |
| `INV-CAP-007` | Auto-allocated stays are room-continuous per booking, with bounded fallback |
| `INV-CAP-008` | Allocation preferences are per lodge and advisory, never safety overrides |
| `INV-CAP-009` | A room-night never mixes one booking's minors with another's adult |
| `INV-CAP-010` | A DOUBLE may hold two confirmed partners; five writers sweep it when broken |
| `INV-CAP-011` | Waitlisted and offered bookings hold no capacity until confirmed |
| `INV-CAP-012` | A waitlist offer reprices at current rates and states what will be paid |
| `INV-CAP-013` | A member may be present on only one live booking per lodge night |
| `INV-CAP-014` | A member on another's booking may remove their own place, and only that |
| `INV-CAP-015` | The person-night 409 payload is scoped to what the requester may see |
| `INV-CAP-016` | That 409 is flow-neutral; only the wizard adds "choose different dates" |
| `INV-CAP-017` | The person-night guard is app-level, lock-ordered and race-free by design |
| `INV-CAP-018` | A member holds at most one group-join roster row per group |
| `INV-CAP-019` | Draft, pending, waitlist, recovery and review states need repair paths |
| `INV-CAP-020` | Provisional-child cancellation is claim-guarded against the hold cron |
| `INV-CAP-021` | An exclusive whole-lodge hold blocks a night at zero beds, unbypassable |
| `INV-CAP-022` | A held booking owns no `BedAllocation` rows on any path, manual or auto |
| `INV-CAP-023` | A held booking's nights are unattributed, non-displaceable planner occupancy |
| `INV-CAP-024` | The requested-room lock follows approved rows, not the exclusive hold |
| `INV-CAP-025` | Approving beds is always scoped; an unselected approval is refused |
| `INV-CAP-026` | The requested-room lock is two-way; move and reviewed removal re-open it |
| `INV-CAP-027` | Allocation moves keep their nights, require review, commit atomically |
| `INV-CAP-028` | Destructive removal is preview-bound, digest-checked, and never replans |
| `INV-CAP-029` | A range assignment writes all or nothing and audits itself exactly once |

---

## 7. Where a new invariant goes

Answerable from the index alone, in four steps:

1. Read the routing table; pick the domain whose "read it when you are
   changing…" line matches your change.
2. Read that domain's file list; pick the file. If two fit, pick the one whose
   prefix your rule will be cited alongside.
3. Take the next number: `max` of that prefix's numbers in the index, plus one.
4. Put the block where a reader would look for it in the file — **not** at the
   end — and add its row to the index in file order.

### 7.1 Worked example: the 34 lines on the dormant `#2681`/`#2682` branch

PR #2696 adds one top-level bullet to `docs/DOMAIN_INVARIANTS.md` at source line
498, inside `### Date handling rules`, between the `@db.Date` comparison rule and
the client-side `yyyy-MM-dd` rule. It states that a server asking for "today"
asks the club's calendar, with two exact boundaries and one reverse case.

Resolved against this scheme:

```
File:      docs/invariants/booking-dates-and-capacity.md
Section:   ## Date handling rules
Position:  immediately after INV-DATE-013, immediately before INV-DATE-014
ID:        INV-DATE-019          <- next free in the prefix, NOT 013.5 and NOT 014
Index row: | `INV-DATE-019` | Ask the club's calendar for "today", never the UTC clock |
```

Note the ID is `019` while the block sits fourth in its section. That is the
allocation rule working, not a mistake. Its internal phrase "see the next
invariant" still points at `INV-DATE-014`, which is still physically next, so no
pointer repair is needed.

**This is also the answer to the merge hazard.** Git will present that branch
with a conflict against a file that no longer holds this section, and the wrong
resolution — accepting the deletion — silently drops a date invariant. The
resolution is: take the 34 added lines, drop them into the file and position
shown above under the ID heading shown above, add the index row, and discard the
conflict on `docs/DOMAIN_INVARIANTS.md`.

---

## 8. Phase 4 enforcement

Two regexes, plus one shape guard. All three are applied line by line **outside
fenced code blocks** — this document, and any future one, must be able to show
an example ID without the checker treating it as real. That is a hard
requirement, not a nicety.

**Definition** — collected only from `docs/invariants/**/*.md`:

```js
/^#{2,4} (INV-[A-Z][A-Z0-9]*-\d{3})\s*$/
```

A definition is a heading whose entire text is the ID. A citation is never a
whole heading line, so there are no false positives in either direction. The
level range `2–4` exists because an ID heading always sits exactly one level
below its nearest structural heading, and a file with no subsections has one
level less.

**Citation** — collected from every tracked `*.md`, `*.ts`, `*.tsx`, `*.mjs`,
`*.js`, `*.sql`, `*.yml` and `*.json` file:

```js
/\bINV-[A-Z][A-Z0-9]*-\d{3}\b/g
```

**Shape guard** — built from the prefixes the definitions actually declared, so
a near-miss under a real prefix is reported rather than being invisible:

```js
new RegExp(`\\bINV-(?:${[...prefixes].join("|")})-[0-9]+\\b`, "g")
```

Every match of it must have exactly three digits. Without this,
`INV-CAP-1` and `INV-CAP-0011` slip past the strict citation regex and resolve
to nothing while being reported as nothing. It is scoped to declared prefixes
rather than to `INV-[A-Za-z]…` generally, because a generic shape guard flags
every Xero invoice fixture in the test suite (§1.2.1).

**The check then asserts, in this order:**

1. No duplicate definition of any ID, across all files.
2. Every citation whose prefix is a **declared invariant prefix** resolves to a
   definition.
3. Every citation whose prefix is **not** declared is either on the reserved
   list — `IB`, `SETTLE`, `SUP`, `SUB`, `XERO`, `FAM`, `LEGACY`, `PM`, `JOR`,
   `REB`, documented in the script as Xero invoice-number fixtures — or the
   check fails with "unrecognised `INV-` prefix: add it to the invariant index
   or to the reserved list". This is what catches a typo'd prefix — a
   misspelling of a real prefix — which a whitelist alone would silently ignore.
4. Every shape-guard match has exactly three digits.
5. Every file under `docs/invariants/` is linked from
   `docs/DOMAIN_INVARIANTS.md`, and every file linked from it exists.
6. Every defined ID appears exactly once in the index.

Assertion 6 is what stops the index rotting, which the issue's own watchpoint
names as the thing most likely to rot. Nothing here needs network, a build or a
Prisma client; the whole check is a single `node` script over `git ls-files`, in
the same shape as `scripts/check-doc-links.mjs`.

A prototype of assertions 1–4 was written and run against this branch during
phase 1. It is what found the invoice-number collision, and it reports the
specimen's 47 definitions with zero unresolved citations and zero malformed
IDs. Phase 4 should not re-derive it — this is the working core:

```js
const RESERVED = new Set(["IB","SETTLE","SUP","SUB","XERO","FAM","LEGACY","PM","JOR","REB"]);
const DEF  = /^#{2,4} (INV-[A-Z][A-Z0-9]*-\d{3})\s*$/;
const CITE = /\bINV-[A-Z][A-Z0-9]*-\d{3}\b/g;

// read a file as [lineNo, text] pairs with fenced code blocks removed
const read = f => { const o = []; let fence = false;
  for (const [i, l] of fs.readFileSync(f, "utf8").split("\n").entries()) {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (!fence) o.push([i + 1, l]); } return o; };

// pass 1: definitions (docs/invariants/** only) and citations (everywhere)
// pass 2: prefixes = new Set([...defs.keys()].map(k => k.split("-")[1]))
//         known prefix  -> must resolve;  unknown prefix -> must be RESERVED
// pass 3: shape guard, built from the declared prefixes only
const SHAPE = new RegExp(`\\bINV-(?:${[...prefixes].join("|")})-[0-9]+\\b`, "g");
//         every SHAPE match must end in exactly three digits
```

Note that inline code spans are **not** skipped, only fenced blocks. Most real
citations in prose will be written as `` `INV-CAP-021` ``, and skipping
backticks would make the check blind to them.

Anchor-style citations (`…#inv-cap-021`) are deliberately **not** handled here —
`npm run docs:linkcheck` already validates fragments against real headings, so
that half is covered and duplicating it would give two places to disagree.

---

## 9. The specimen, and why this section

**Chosen: `## Booking Dates And Capacity` (source 352–1214) → 
[`booking-dates-and-capacity.md`](booking-dates-and-capacity.md), 47 IDs across
two prefixes.**

It stress-tests more of the scheme than any other section of comparable size:

- **It is the only section carrying two prefixes**, so it is the miniature of
  the question the big sections ask — when does a heading zone become its own
  file, and when does it share one. It answers it: `INV-DATE` and `INV-CAP` stay
  together because `INV-CAP` refers to `INV-DATE` positionally six times.
- **It contains the self-referential normative block** at source 354–365 — the
  one the issue cites as evidence that a correctly-written rule still failed.
  The specimen shows that instruction surviving intact: because the `###`
  subsection heading moves verbatim (becoming a `##` in its own file), "this
  subsection" still resolves, with no edit at all. That is the argument for
  keeping the source's heading text rather than flattening to a list of IDs.
- **It owns the most inbound deep links** — four to the stay-boundary anchor
  from `CAPACITY_MODEL.md` and `lobby-display/design.md`, plus five to the
  section anchor — so it exercises both link rules in §4.1.
- **It carries the hardest cross-file pointer**, the custodian bed hold at
  source 458–459 whose target lives in Membership Lifecycle, and its reciprocal
  at 6838–6840.
- **It has the widest block-size spread in the document**: a one-line block
  (`INV-CAP-011`, source 902) next to a 149-line one (`INV-CAP-010`, source
  753–901). If the block rule survives that range it survives anywhere.
- **It is the domain the issue's own evidence indicts** — PRs #2622, #2630,
  #2631 and #2632 all fixing surfaces that disagreed about which day it was, and
  the Lane A capacity finding.

At 863 lines it is large enough to be a real transcription and small enough not
to consume phase 2.

**What it does not test:** a domain with no subsections at all (Payment And
Settlement, 931 lines, zero `###`). Phase 2 should do that one first of the
remaining fourteen, because it is the one that will find a gap in this scheme if
there is one.

---

## 10. Found in phase 1, deliberately not fixed

None of these were changed. Each is a candidate for its own issue.

1. **`docs/DOMAIN_INVARIANTS.md:6292` points the wrong way.** "#2424 (above) has
   since closed the parent-email exposure" — the #2424 block is at 6480–6519,
   which is *below*. Pre-existing navigation defect.
2. **A deliberate verbatim duplicate at 3051** — "Coverage is existential, not an
   assignment. Stated again because it is the invariant most easily broken by an
   optimisation" repeats 3036–3038. Under the block rule both blocks get IDs,
   which is honest but means two IDs carry the same rule. Worth an owner call on
   whether the second should become a `See INV-HOST-0NN` pointer.
3. **A self-documented erratum at 5725–5741** — "This one is NOT covered by the
   `cancelledAt`/`archivedAt` refusal and **was wrongly documented here as if it
   were.**" The correction is in the document; the rule around it may still need
   review.
4. **Roughly 2,150 of the 3,069 lines under "Booking Modifications" are not about
   modifying a booking.** They are hosting policy, subscription-lockout pricing,
   notification policy, account deletion, Xero reconciliation, booking requests
   and admin queues. Likewise `## Membership Lifecycle` contains a 61-line
   custodian bed-occupancy block (6828–6888) that is a capacity invariant end to
   end, and a 115-line `FamilyGroupMember.role` column-drop narrative
   (6364–6478) that is migration-policy material. Re-domaining is a separate,
   reviewable change; doing it inside a restructure would make both unreviewable.
5. **Two heading zones stop describing their content partway through** — #2533 at
   3902, #2350 at 5040 (§5.1). Splitting them is the natural follow-up to (4).
6. **`INV-CAP-010` is 149 lines under one ID** (source 753–901, double-bed shared
   occupancy). Coarse, and the scheme supports refining it later without
   renumbering, but not in a transcription phase.
7. **The file has no blank line before `### Capacity and allocation`**
   (source 581/582). Cosmetic; the split removes it incidentally.
8. **Six passages are explicitly "flagged for owner confirmation"** and one is
   labelled "**The general case is NOT handled**" (6737–6742). They are rules
   the document itself does not consider settled. They move verbatim and keep
   their flags; somebody should schedule the confirmations.

---

## 11. Decisions the owner should confirm before phase 2 starts

1. **Three-digit numbers** (`INV-CAP-007`) rather than the issue body's
   two-digit illustration (`INV-CAP-07`). §1.1. This is the only divergence from
   the issue text and it is irreversible after phase 2.
2. **The index stays at `docs/DOMAIN_INVARIANTS.md`** rather than moving to
   `docs/invariants/README.md`. §6. Saves ~97 edits and keeps every existing
   reference and fork citation valid.
3. **One ID per block, not per sentence.** §2. Every normative sentence is
   *covered* by exactly one ID; a long block gets one ID. The alternative
   requires re-wrapping prose, which is how a word changes unnoticed.
4. **Files follow the document's existing headings; nothing is re-domained.**
   §5.1. The mis-filing is real and is recorded in §10 for a separate issue.
5. **`subscription-lockout-pricing.md` (16k) and `membership-lifecycle.md` (24k)
   stay whole.** §5.2. Splitting either needs invented headings and breaks
   internal pointers.
6. **The ` [INV-*]` pointer insertion is a permitted edit.** §3, edit type 2. It
   is the only mechanism by which phase 2 adds a word to normative prose, it
   deletes and rewords nothing, and every use is registered in the PR body.
7. **Keep the `INV-` namespace despite the Xero invoice-number collision.**
   §1.2.1. The recommendation is yes — the failure mode is a loud CI error, not
   a silent mis-resolution, and the issue specifies `INV-*`. The alternative is
   a distinct namespace (`ACB-CAP-007` or similar) that cannot collide at all.
   This one is genuinely irreversible after phase 2 and is the decision most
   worth ten seconds of the owner's attention.
