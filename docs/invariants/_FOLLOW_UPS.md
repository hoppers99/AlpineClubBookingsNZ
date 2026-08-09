# Found during the invariant restructure, deliberately not fixed

Audience: Developer, Agent.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) · ID scheme:
[`_PHASE1_SCHEME.md`](_PHASE1_SCHEME.md).

The `INV-*` restructure (#2691) was a **move**, not an edit: it inserted id
headings, re-pointed three relative link paths and added a handful of bracketed
`[INV-*]` cross-file pointers, and changed no other word. Everything below was
noticed while doing that and left exactly as it was found, because a restructure
that also changes meaning is unreviewable.

**This file is a to-do list, not a rule.** Nothing here is normative and nothing
here has an id. Each item is a candidate for its own issue; when one is filed,
add the number beside it. Fixing any of them is a separate, reviewable change
against the file that holds the rule.

---

## 1. Coarse blocks: one id covering many independently-normative rules

The scheme gives one id per **block**, and a block is never split mid-bullet
(`_PHASE1_SCHEME.md` §2), because splitting one means inserting a heading inside
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

Refining any of these is cheap under the scheme (`_PHASE1_SCHEME.md` §1.4): the
part that keeps the original meaning keeps the id and the new parts take fresh
numbers, so no existing citation moves. It just must not happen inside a
transcription.

## 2. A citation to an identifier that is defined nowhere in `docs/`

`INV-PAY-018` (source line 1701) says change fees "stay non-refundable per
FEE-03". `FEE-03` is not defined anywhere in the documentation tree. It survives
only as a comment token in `src/lib/booking-cancel.ts` and two test files, so a
reader who follows it lands on nothing.

Either give the rule a real home and cite that, or drop the identifier.

## 3. A navigation pointer that points the wrong way

`INV-LIFE-035` (source line 6292) reads "#2424 (above) has since closed the
parent-email exposure". The #2424 material is `INV-LIFE-038`, which is **below**
it. This was already wrong in the source document and is carried across
unchanged.

## 4. Near-duplicate rules

Each pair states the same obligation twice, under different ids, so a change to
one can leave the other stale.

- **`INV-PAY-027` and `INV-PAY-030`** — "Payment, refund, and credit operations
  must be idempotent across retries, webhook replays, cron reruns, and partial
  failure recovery" and "External provider side effects require clear retry and
  idempotency behavior".
- **`INV-MONEY-001`, `INV-MONEY-003` and `INV-MONEY-006`** — "Store and calculate
  money as integer cents", "Do not introduce floating point money arithmetic" and
  "…must reconcile back to cent-based ledger records" are three statements of one
  integer-cents rule.
- **Inside `INV-HOST-023`**, the bullet "Coverage is existential, not an
  assignment" appears twice, verbatim, the second time prefaced "Stated again
  because it is the invariant most easily broken by an optimisation". That
  repetition is deliberate in the source; it is recorded here only so a later
  editor does not remove one copy believing it a mistake.

The scheme's answer for a genuine duplicate is to keep both ids and make the
absorbed one a `Superseded by` stub (`_PHASE1_SCHEME.md` §1.4), never to delete
one — but which is the survivor is an owner call, not a transcription decision.

## 5. Headings that stopped describing their content

Two `###` heading zones in the source ran on past their subject, and the split
followed the source's headings rather than re-domaining anything:

- `### Subscription-lockout booking pricing (#2533)` (source 3477–4541) stops
  being about subscription lockout at **source line 3902**. Everything from
  `INV-LOCKOUT-037` onward — the admin date override, the `notifyMember` regime,
  the "No emails" switch, retroactive creates, the capacity-override marker and
  the unpaid-finished-stay queues — is under a heading that does not describe it.
- `### Chasing an outstanding additional payment (#2350)` (source 4915–5427)
  stops at **source line 5040**. From `INV-ADDPAY-003` onward the file holds the
  minors-review rules, quote and booking-request holds, the paid-name lock and
  the refund/credit-note settlement rules.

Both files' front matter and prefixes describe what is actually in them; only the
transcribed section headings still carry the narrow titles.

## 6. Blocks whose domain does not match the file they are in

Both are in `membership-lifecycle.md` because that is where the source put them.
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

## 7. Passages the document itself does not consider settled

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

## 8. One positional cross-reference whose target has left the file

`INV-DATE-009` in
[`booking-dates-and-capacity.md`](booking-dates-and-capacity.md) still reads
"The custodian bed hold uses deliberate inclusive day semantics (its own section
below)". That section is now `INV-LIFE-062`, in a different file, so "below" no
longer navigates. The scheme's registered remedy is edit type 2 — append
` [INV-LIFE-062]` beside the phrase, deleting and rewording nothing
(`_PHASE1_SCHEME.md` §3, §4.2). It was not applied to this one occurrence.

The reciprocal direction is fine: `INV-LIFE-062` names the section by title
("the stay-boundary invariant in 'Booking Dates And Capacity'"), which survives
the move.
