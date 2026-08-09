# Found during the invariant restructure, deliberately not fixed

Audience: Developer, Agent.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) · ID scheme:
[`SCHEME.md`](SCHEME.md).

The `INV-*` restructure (#2691) was a **move**, not an edit: it inserted id
headings, re-pointed two relative link paths and added eight bracketed
`[INV-*]` cross-file pointers, and changed no other word. Everything below was
noticed while doing that and left exactly as it was found, because a restructure
that also changes meaning is unreviewable.

**This file is a to-do list, not a rule.** Nothing here is normative and nothing
here has an id. Fixing any of them is a separate, reviewable change against the
file that holds the rule.

**Every item below is filed, and most are now closed.** #2706 covered the
structural work (splitting the over-coarse ids, re-homing the two mis-domained
blocks) — §1 and §6 are closed. #2707 covered the four documentation defects —
§2, §3, §4 and §5 are closed. **The one section still outstanding is §7**, where
#2708 puts the six unsettled passages to the owner as a decision. Nothing here is
carried as prose alone: a comment does not get a fix done, and this file is a
register of filed work, not a substitute for it.

---

## 1. Coarse blocks: one id covering many independently-normative rules — closed by #2706

**Nothing outstanding here.** Every block in the table below was split in #2706:
the part that retains the original meaning kept its id, each new part took a
fresh number, nothing was renumbered and no rule's wording changed. The two
splits that could not be made without re-wrapping prose are named at the end of
this section. The table is kept because it records what was coarse and why.

The scheme gives one id per **block**, and a block is never split mid-bullet
(`SCHEME.md` §2), because splitting one means inserting a heading inside
a list item, re-indenting the prose and re-wrapping every line — which is exactly
how a word changes unnoticed. The consequence is that a few very long blocks each
carry a great many separate obligations under a single id, so citing one of them
is much less precise than citing an ordinary id.

Sizes are measured in the destination file, from the id heading to the next
heading.

| ID | ≈lines | Why it is coarse |
| --- | ---: | --- |
| `INV-PAY-001` | 254 | Manual mark-paid: provenance, three invoice fences, the reciprocal inbound fence, duplicate-capture, cancellation, reversal, the #2397 uncollected-extra contract and the generalised ledger mirror — each independently normative |
| `INV-LOCKOUT-037` | 231 | Starts as the admin date override and its two pricing modes, then absorbs the whole per-action `notifyMember` regime and the entire account-deletion approve/reject/release protocol |
| `INV-LOCKOUT-039` | 225 | The per-booking "No emails" switch: mailer enforcement, the booking-link authority gate, waitlist interaction, Xero invoice email, the acknowledgement dialog, the withheld-list banner and the prompt-suppression contract |
| `INV-EXCEPT-001` / `-002` / `-003` | 117 / 39 / 217 | Three ids for the whole policy-exception feature (≈373 lines): request store, reservation, approval, execution, capacity recheck, member surfaces and officer decision |
| `INV-LIFE-037` | 179 | The four powers over a non-login member, plus the `FamilyGroupMember.role` column-drop narrative (see §6) |
| `INV-LIFE-065` | 172 | Member profile merge in full: field merge, relation buckets, subscription collision, Xero teardown, guards, preview token and refusal auditing |
| `INV-CAP-010` | 152 | Double-bed shared occupancy and the five writers that sweep it |
| `INV-LIFE-017` | 149 | Application-approval mapping, the privileged-email gate, three on-behalf pickers, non-member owner creation, membership-type merge rules and the age-tier precedence ladder |
| `INV-ADDPAY-001` | 125 | Who is owed, who may pay, what is sent, the cutover, idempotency stamps, the shared clock and the unreachability pre-check |
| `INV-MONEY-005` | 105 | Promo "use" semantics plus every cap, lock, reprice-coverage and trap rule beneath it |

Refining any of these is cheap under the scheme (`SCHEME.md` §1.4): the
part that keeps the original meaning keeps the id and the new parts take fresh
numbers, so no existing citation moves. It just must not happen inside a
transcription.

**Two splits were declined, and both are recorded here rather than left to be
rediscovered.** Inside `INV-PAY-046` the #2397 uncollected-extra contract and
inside `INV-PAY-047` the generalised ledger mirror are each a single unbroken
paragraph, so every sentence boundary inside them falls mid-line. Splitting
either would mean re-wrapping the prose, which is exactly how a word changes
unnoticed, so both stay whole at 97 and 55 lines. The same is true of the point
where `INV-LOCKOUT-037` stops being about the date override and starts being
about the `notifyMember` regime: that sentence begins mid-line, so the first
clean boundary is the #1780 sweep (`INV-LOCKOUT-044`) and the earlier
`notifyMember` rules stay under `INV-LOCKOUT-037`.

## 2. A citation to an identifier that is defined nowhere in `docs/` — closed by #2707

**Nothing outstanding here.** `INV-PAY-018` said change fees "stay non-refundable
per FEE-03", and `FEE-03` was defined nowhere in the documentation tree — it was
an acceptance-criterion number from the Phase 8a change-fee work, surviving only
as a comment token in `src/lib/booking-cancel.ts` and two test files.

The rule it named turned out to have a real home, and it is `INV-PAY-018` itself:
the very sentence carrying the dangling citation states the refundable-base
formula and the exclusion. So the identifier went rather than being re-pointed
(a rule does not cite itself), and the surviving code and test tokens now name
`INV-PAY-018`, which `npm run docs:indexcheck` can resolve.

## 3. A navigation pointer that points the wrong way — closed by #2707

**Nothing outstanding here.** `INV-LIFE-035` read "#2424 (above) has since closed
the parent-email exposure" while the #2424 material, `INV-LIFE-038`, is **below**
it in the same file. It now reads "#2424 [INV-LIFE-038]": the wrong direction
word is gone and the target is named by id, which survives a later move where
"above" and "below" do not.

## 4. Near-duplicate rules — refuted, and cross-linked instead by #2707

**Nothing outstanding here, and nothing was superseded.** The owner's decision of
9 Aug 2026 on #2707 refuted the finding: read against the invariant text these
are facets of one area, not restatements of one rule, and merging any pair would
drop coverage.

- **`INV-PAY-027` and `INV-PAY-030`** cover different things. `-027` governs
  *our* payment, refund and credit operations; `-030` governs *external provider*
  side effects, which reaches email and Xero, not just money. Merging them would
  narrow `-030` to the money paths.
- **`INV-MONEY-001`, `INV-MONEY-003` and `INV-MONEY-006`** are three facets.
  `-001` is the representation rule, `-003` is its *enforceable* form (a lint
  rule can catch floating-point arithmetic; "store as integer cents" is not
  mechanically checkable), and `-006` is a distinct reconciliation obligation.
  Collapsing them would lose the one a machine can check.

All five now carry a `Related:` line naming their siblings, so a change to one
prompts checking the others — which is the actual risk the finding identified.
The scheme's supersede machinery (`SCHEME.md` §1.4) stays available for a genuine
duplicate; this was not one.

**One thing here is not a defect and must not be "fixed".** Inside
`INV-HOST-023` the bullet "Coverage is existential, not an assignment" appears
twice, verbatim, the second time prefaced "Stated again because it is the
invariant most easily broken by an optimisation". That repetition is deliberate
in the source. It is recorded here only so a later editor does not remove one
copy believing it a mistake.

## 5. Headings that stopped describing their content — closed by #2707

**Nothing outstanding here.** Two `###` heading zones in the source ran on past
their subject, and the split followed the source's headings rather than
re-domaining anything (heading text never changes inside a transcription,
`SCHEME.md` §3). Both headings were widened in #2707, in the files and in the
index, and the one inbound prose reference — in `docs/CONCURRENCY_AND_LOCKING.md`
— was re-pointed at the domain file instead of at a heading:

- `Subscription-lockout booking pricing (#2533)` (source 3477–4541) stopped being
  about subscription lockout at **source line 3902**: everything from
  `INV-LOCKOUT-037` onward is the admin date override, the `notifyMember` regime,
  the "No emails" switch, retroactive creates, the capacity-override marker and
  the unpaid-finished-stay queues. It now reads "Subscription-lockout pricing
  (#2533), admin date overrides and member-facing email".
- `Chasing an outstanding additional payment (#2350)` (source 4915–5427) stopped
  at **source line 5040**: from `INV-ADDPAY-003` onward the file holds the
  minors-review rules, quote and booking-request holds, the paid-name lock and
  the refund/credit-note settlement rules. It now reads "Additional-payment
  chasing (#2350), request holds and refund settlement".

No rule's wording changed, and no id moved.

## 6. Blocks whose domain does not match the file they are in — closed by #2706

**Nothing outstanding here.** Both blocks below were re-homed in #2706:
`INV-LIFE-062` to `booking-dates-and-capacity.md`, keeping its number and its
prefix, and the `FamilyGroupMember.role` column-drop narrative to
`operations.md` as `INV-OPS-005` to `INV-OPS-011`. Neither move changed a word.
One consequence is worth stating: `INV-LIFE` now spans two files. That is the
price of the no-renumber rule — a merged id can move file but can never change
number — and `SCHEME.md` §1.5 now states that outcome directly, so it is settled
rather than outstanding: a re-homed id keeps its number and its prefix, and the
index, not the prefix, is authoritative for id → file.

Both were in `membership-lifecycle.md` because that is where the source put them.
Ids are location-independent and the index is authoritative for id → file, so
re-homing either later costs nothing and breaks no citation.

- **`INV-LIFE-062` — the custodian bed-occupancy block.** It is a capacity
  invariant end to end: it defines inclusive night semantics, states that
  `occupiedBeds + availableBeds === lodgeCapacity` still holds, forbids two
  assignments on one bed on an overlapping night, and pins the bed-allocation
  write-path and lock discipline. It belongs beside `INV-CAP`.
- **The `FamilyGroupMember.role` column-drop narrative nested inside
  `INV-LIFE-037`.** Roughly a hundred lines on Prisma's `@ignore` behaviour, what
  a generated client can emit, the `old_code_compatible=windowed` ledger row, the
  `rollback.sql` and the operator sequence. That is migration policy, not
  membership lifecycle, and it also happens to be most of why `INV-LIFE-037` is
  as coarse as it is (§1).

More broadly, roughly 2,150 of the 3,069 source lines under
`## Booking Modifications` were not about modifying a booking. The split gave
each of those bodies its own file and prefix, but they are all still listed under
that one index heading, because 21 of the 27 inbound anchor links in the
repository target the source `##` headings and keeping them byte-identical is
what makes those links need no edit.

## 7. Passages the document itself does not consider settled — filed as #2708

These are rules whose own text says they are awaiting a decision. They moved
verbatim and kept their flags. Somebody should schedule the confirmations.

- **`INV-LIFE-044`** — "Two decisions here were taken by the delivering agent
  under D9's remit rather than by the owner, and are **flagged for owner
  confirmation** (2026-07-27, #2255): the depth number itself (four generations)
  and transitive email inheritance as described below."
- **`INV-LIFE-047`** — transitive email inheritance, "flagged for owner
  confirmation alongside the depth number".
- **`INV-LIFE-054`** — the age-up re-resolution sweep, which states plainly:
  "**The general case is NOT handled**: if an ancestor's email address changes,
  or a middle generation gains an address by some other route, existing pointers
  keep naming whoever they named." Recorded there as a known limitation and
  flagged for the owner, because the fix is a consent question.
- **`INV-PAY-023`** — "ACCOUNTING-POLICY flag (open): the minted remainder note
  posts to the shared `hutFeeRefunds` mapping; whether admin / goodwill credit
  should post to a distinct write-off account is an owner call."
- **`INV-LIFE-013`** — a self-documented erratum rather than an open question,
  but in the same family: "This one is NOT covered by the
  `cancelledAt`/`archivedAt` refusal and **was wrongly documented here as if it
  were.**" The correction is in the document; the rule around it may still be
  worth a review.
- **`INV-LIFE-015`** — records that stamping `cancelledAt` (or a dedicated
  `deletedAt`) at anonymisation time "would make the state structural instead of
  inferred; it is deliberately still open".

## 8. Positional cross-references that crossed a file boundary — closed

**Nothing outstanding here.** This section records the sweep so a later reader
does not have to repeat it.

The source document navigated itself with "above", "below", "its own section
below" and "rule (b) above". Where the target stayed in the same destination
file, the sentence was left completely alone (`SCHEME.md` §4.2, rule 1)
— that covers the large majority, and is why the file boundaries follow the
source's own heading zones. Where a reference crossed a new file boundary, edit
type 2 was applied: a bracketed ` [INV-*]` pointer **appended** beside the phrase
that no longer navigates, deleting and rewording nothing.

Every `##`/`###` file was swept for `above`, `below`, `earlier`, `preceding`,
`its own section`, `this subsection`, `see the … invariant/rule/cluster`,
`named above/below`, `as described above/below` and `rule (x) above`. Eight
boundary-crossing references were found and all eight now carry a pointer; the
complete register is in the pull request body and reproduced nowhere else, so
that the PR carries the exhaustive list of edits made to transcribed text.

Two classes were deliberately left unpointered, both per the scheme:

- **References that name their target by section title** — "the stay-boundary
  invariant in 'Booking Dates And Capacity'" (four occurrences) and 'see
  "Member-Guest Consent"' (one). A title resolves through the index whatever file
  it lives in, so these navigate correctly without an edit (`SCHEME.md`
  §4.1, §4.2).
- **The one reference that pointed the wrong way** — `INV-LIFE-035`'s "#2424
  (above)", whose target `INV-LIFE-038` is below it in the *same* file. That was
  a pre-existing direction error, not a crossed boundary, so edit type 2 did not
  apply and a pointer inside the transcription would have papered over it. It was
  left visible, recorded in §3, and fixed there by #2707.
