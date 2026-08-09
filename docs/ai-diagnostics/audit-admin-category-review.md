# The `admin` audit category, reviewed site by site (#2730)

**What this page is.** A record of every production audit writer that recorded
`category: "admin"`, read one at a time against the owner's rule that **the
category follows the business domain the event affected, never who performed
it**. Twenty-two were wrong and were moved; ninety-six were read and kept, and
this page says why each was kept rather than leaving `admin` to look like the
absence of a decision.

**Why it exists.** `AuditLog.category` is a permission decision, not a label.
It decides which AI Diagnostics correlation entry can return the row — and
therefore which admin areas an operator must hold — and whether the member the
row concerns sees it on their own activity list. [#2581](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2581)
gave every writer a category; PR #2676 classified the 82 that had none and
**explicitly did not read the 118 that already said `admin`**, which is the
platform's catch-all. #2581's own readiness note said those classifications
"cannot be assumed correct". This is the pass that checked.

For the taxonomy itself, and which permission each category sits behind, see
[the support tool pack](tool-pack-support.md) and
[`src/lib/audit-categories.ts`](../../src/lib/audit-categories.ts). For the
operator's view of the same table, see [the audit log guide](../guides/audit-log.md).

## The two readerships every verdict below is measured against

| | Who can correlate it in AI Diagnostics | Can the member it concerns see it? |
| --- | --- | --- |
| `admin` | `support:view` alone | **No** |
| `lodge` | `support:view` **+ `lodge:view`** | **No** |
| `family`, `account`, `privacy`, `communication` | `support:view` **+ `membership:view`** | **Yes** |
| `security` | `support:view` alone | **Yes** |
| `booking` | `support:view` **+ `bookings:view`** | Yes |
| `payment`, `xero` | `support:view` **+ `finance:view`** | payment yes, xero no |

Two consequences run through everything below.

1. **Moving out of `admin` into any non-member category is a narrowing.** A
   support-only operator loses evidence they can correlate today. They can still
   read the row in **Admin → Audit Log**, which needs `support` and nothing else,
   so nothing becomes unreadable — but the AI Diagnostics channel closes.
2. **Moving out of `admin` into a member-visible category is a widening**, and it
   is the direction this pass would not take on its own. Every writer in this
   population passes the acting administrator's own member id as `memberId`, and
   `buildMemberVisibleAuditLogWhere` matches on it, so *any* such move at minimum
   publishes the row on the acting administrator's own activity page — and where
   `subjectMemberId` names a different member, it publishes to that member too.
   The member projection withholds metadata, request id, IP and drill-downs, but
   it returns `action`, `summary` and — whenever `details` is not a JSON object —
   `details` **verbatim**.

Retention is the third axis and it is quiet. `classifyAuditRetention` reads the
category, so a reclassification can silently change how long a row is kept.
Every verdict below states whether it does.

## Moved: 22 sites, `admin` → `lodge`

Both a **narrowing** on the AI Diagnostics axis and **retention-neutral**:
`classifyAuditRetention` returns `critical` (7 years) for all 22 under both the
old and the new category, measured rather than assumed. Neither category is
member-visible, so **no row reached a member who could not read it before**.

### Bed allocation — 21 sites

| File | Sites |
| --- | ---: |
| `src/app/api/admin/bed-allocation/allocations/bulk/route.ts` | 2 |
| `src/app/api/admin/bed-allocation/allocations/route.ts` | 2 |
| `src/app/api/admin/bed-allocation/auto-allocate/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/beds/[id]/route.ts` | 2 |
| `src/app/api/admin/bed-allocation/beds/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/rooms/[id]/route.ts` | 2 |
| `src/app/api/admin/bed-allocation/rooms/bulk/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/rooms/import-from-config/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/rooms/route.ts` | 1 |
| `src/app/api/admin/bed-allocation/settings/route.ts` | 1 |
| `src/lib/admin-bed-allocation.ts` | 5 |
| `src/lib/bed-allocation-removal.ts` | 2 |

**Why.** This was the clearest violation in the repository, and it was written
down: the automatic path in `bed-allocation-lifecycle.ts` carried a comment
arguing that because "there is no acting member … this is a 'lodge' system event
rather than an 'admin' action". That is classification by initiator, and the
three admin-initiated writers of the **same action name** took it at its word.
`BED_ALLOCATION_PARTNER_PROMOTED` and `BED_ALLOCATION_PARTNERS_PROMOTED` were
each written into two different permission gates, with the same `entityType`,
the same `targetId` shape and near-identical summaries.

**What went wrong for a real person.** A Lodge Manager holding Support + Lodge
asked AI Diagnostics to correlate bed-allocation promotions for a night. The
Lodge entry read only `lodge`, so it returned the automatic promotions, omitted
every manual, bulk and range one, and reported that nothing else matched — an
answer that reads as a bounded absence rather than a partial one. A support-only
operator got the mirror image. Bed allocation is now wholly `lodge`: 28 sites,
one gate.

**Who loses.** A support-only operator, and a Booking Officer holding
`support` + `bookings` but not `lodge` — worth naming, because the routes that
*write* these rows are gated on `bookings:edit`, not `lodge:edit`. They keep full
access through Admin → Audit Log. The comment that caused the split has been
replaced with one that states the affected-domain reason instead.

### `LODGE_DISPLAY_CONFIG_UPDATED` — 1 site

`src/app/api/admin/display/lodge-config/route.ts`. The last writer under
`/api/admin/display/**` still saying `admin` while its ten siblings said
`lodge` — and the most lodge-scoped of them, with `entityType: "Lodge"` and
`entityId: lodgeId`, on a route gated `lodge:edit`. Nine of the ten siblings were
among #2676's 82, so that sweep is what turned a uniformly `admin` subsystem into
a split one. An operator with Support + Lodge could see every layout, template and
device change for a misbehaving kiosk but not the config change that caused it.

## Kept: 96 sites

Each group states the affected domain that makes `admin` right, and — where the
alternative reading is real — what taking it would have cost.

### Platform, club and section configuration — 20 sites

AI assistant and AI Diagnostics settings; club contact and club identity; module
toggles; member-field settings; notification delivery policies; admin
notification preferences; public-content settings; email message settings and
both email-template override writers; membership cancellation, lockout and
nomination settings; member-guest settings; internet-banking payment settings;
both booking-message override writers; `booking_request.settings_updated`.

**Kept because the affected domain *is* administration.** These change the club's
own configuration, not a booking, a member or a payment. This is what `admin`
means when it is not being used as a catch-all, and a taxonomy with no home for
"an administrator changed a platform setting" would need to invent one.

Three of these have a live alternative reading and were kept deliberately:

- **`INTERNET_BANKING_PAYMENT_SETTINGS_UPDATED`** could read as `payment`. It
  configures how money is taken, but takes none; `payment` is reserved for
  movements of money, which is what makes the Finance entry's answers about a
  charge trustworthy. The existing model-facing description already names this
  trap to operators.
- **The two booking-message writers and `booking_request.settings_updated`**
  could read as `booking`, and the booking-policy writers #2676 classified *did*
  go to `booking`. The distinction kept here is that a booking policy is a rule
  the booking engine evaluates, whereas message wording and request-form settings
  are presentation and workflow configuration. **This is the weakest keep on the
  page** and a reasonable reviewer could move all three; it is recorded as a
  judgement rather than a certainty.
- **The two email-template writers** could read as `communication`. They were
  kept because `communication` is member-visible and these writers pass the
  acting administrator's `memberId`, so moving them would publish template edits
  on that administrator's own activity page for no operator benefit.

### Access-role definitions — 3 sites

`src/app/api/admin/access-roles/**`. The affected object is the club's admin
permission model itself. `security` is the alternative and is retention-identical
(`sensitive_access`, 24 months, because the action contains the word "access")
and readable by the same `support:view` — but `security` **is** member-visible,
so the move would publish role-definition edits on the editing administrator's
activity page and buy nothing.

### Committee roles and assignments — 6 sites

`src/app/api/admin/committee/**`. Club governance structure. `account` was
considered for the assignment writers, since an assignment names a member; it was
rejected because the affected record is the committee, and `account` is
member-visible.

### Configuration import and export — 3 sites

`config-transfer/apply`, `config-transfer/export`, `src/lib/config-transfer/apply.ts`.
Whole-platform configuration movement. Unambiguously administration.

### Site content and presentation — 15 sites

Page content (4), site banners (3), site content, site style and logo (2), image
library (2), notices (3). The affected domain is the club's published content.
`communication` was considered for notices and rejected: the notice *record* is
content, and the notice *email* already writes `notice.emailSent` under
`communication` from `src/lib/notices-email.ts` — two events, correctly two
categories.

### Lodge-gated operational configuration — 15 sites

Chores (3), lockers (4), lodge instructions (2), lodge settings (1), lodge
entities (2), work parties (3).

**Kept in this pass, but this is the group most likely to move next, and it is
recorded as an open question rather than a settled keep.** Every one of these
routes except lockers is gated on `lodge:*`, their affected objects are lodge
artefacts, and at least one has a sibling split of exactly the shape this pass
fixed elsewhere: `lodge.chore.completed` is written `lodge` from
`src/app/api/lodge/roster/[date]/route.ts`, while `CHORE_TEMPLATE_UPDATED` — the
change that alters the roster somebody is completing — is `admin`.

They were not moved here because no decision on #2730 covers them: the issue
named four defects and gave each a direction to tick, and moving fifteen more
sites out of the support-only gate is a readership change of its own size. It
would be a narrowing, member-invisible in both directions, and retention-neutral
(`critical` either way, and `locker.*` and `workparty.*` contain no access-event
word). The lockers writers are the odd ones out: their routes are gated
`membership:*` and a locker is allocated to a named member, so `lodge` is not
obviously their answer either.

### Induction templates — 4 sites

`src/app/api/admin/induction-templates/**`. The sibling reading is real —
induction *records* are `lodge` (`induction.ts`, `induction-baseline.ts`), and
both the support pack and the audit-log guide already warn operators that
induction is filed under `lodge` even though the screen sits under Membership.
Kept because the template is the club's induction *policy* document rather than
any lodge's operations, and because the routes are gated `membership:*`, so a
move to `lodge` would put the evidence behind a permission the people who create
it do not need. Grouped with the lodge-gated question above for whoever takes the
next pass.

### Calendar events — 4 sites

`src/app/api/calendar/events/**`. Club calendar administration, gated to calendar
managers. `calendar.event.join` mints a MiroTalk **host** credential, which makes
`security` arguable; it was kept because `security` is member-visible and the row
would then appear on the minting manager's own activity page.

### Membership types — 6 sites

Create, update, delete, reorder and merge. These are the club's membership
*product definitions* — price bands and eligibility rules — not any member's
membership. `account` would be wrong for that reason and member-visible besides.

### Member merge — 2 sites

`MEMBER_MERGED` and `MEMBER_MERGE_REFUSED` in `src/lib/member-merge.ts`. Kept,
and this one is pinned elsewhere: `INV-LIFE-083` records the refusal row as
`category admin, outcome blocked`, so moving it is a documented-invariant change
rather than a reclassification. The support pack's model-facing description also
names "member merges are recorded under admin" to stop an operator reading an
empty membership-entry result as absence.

### Member import, lodge access, admin member detail — 3 sites

- `member.imported` (`admin/members/import`): a bulk administrative import.
- `MEMBER_LODGE_ACCESS_UPDATED` (`admin/members/[id]/lodge-access`): **kept, with
  a retention reason.** The action contains the word "access", so
  `classifyAuditRetention` returns `sensitive_access` — 24 months — *because* the
  category is `admin`. Under `lodge` or `account` the same row becomes `critical`
  and is kept for **seven years**. Moving it is therefore a data-lifecycle change
  as well as a permission change, and needs to be decided as one.
- The dynamic writer in `admin-member-detail-service.ts`: an administrator's edit
  to another member's record. `account` is arguable and member-visible; the
  member-facing half of this surface is already covered by the `account` writers
  #2676 classified.

### Seasonal membership assignments — 4 sites

`src/lib/seasonal-membership-assignments.ts`. Bulk administrative assignment of
season membership tiers. The support pack already names these to operators as
`admin`.

### Xero member-import membership types — 1 site

`src/lib/xero-member-import.ts`. The affected object is the membership-type
catalogue the import creates, not the Xero link — `xero` would file a
membership-configuration change behind Finance.

### Analytics integration — 2 sites

`ANALYTICS_SETTINGS_UPDATED` and `ANALYTICS_CONSENT_REVISION_BUMPED`. `privacy`
is a genuine alternative — consent is the privacy domain (`INV-PRIV`) — but
`privacy` is member-visible and these rows carry no member subject, so the move
would publish a settings change on the acting administrator's activity page and
narrow the operator gate at the same time. Kept, and flagged as re-decidable.

## Held for an owner decision: 8 sites

These are the two #2730 findings this pass **did not** apply, because both
destinations are member-visible and each move publishes rows on a member-facing
surface. A widening is not a refactor and is not this lane's to take.

### `member_lifecycle.delete_*` and `archive_*` — 6 sites

`src/lib/member-lifecycle-actions.ts`. All six pass
`subjectMemberId: <the member being deleted or archived>`, so filing them under
`privacy` (or `account` for the archive trio) publishes them **to that member**,
not merely to the acting administrator. The row's `details` is `cleanedReason` —
free text an administrator wrote to justify the request — and the member
projection returns `details` verbatim whenever it is not a JSON object. The
acting administrator is rendered as "Club admin" only if their role is `ADMIN`;
any officer holding the permission through an access role is **named in full**.

The case for moving is strong and unchanged: the member-initiated equivalents
(`member.deletion_requested` / `_rejected` / `_approved`) are already `privacy`,
so the same act answers to two gates depending on who started it, and
`audit-query.ts` files `member_lifecycle.delete*` under `privacy` on the read
side in two places. It is also retention-neutral. But it is a widening, and it
wants the owner's explicit answer to a plain question: **should a member be able
to see, on their own activity page, that their deletion was requested, who
requested it, and the reason they gave?**

### `FAMILY_SUGGESTION_HIDDEN` and `FAMILY_SUGGESTIONS_RESET` — 2 sites

`admin/family-suggestions/hide` and `.../reset`. Checked at the writers as #2730
asked: `targetId` is a suggestion signature rather than a member id and
`subjectMemberId` is unset, so **no third-party member** is published to. But
both pass `memberId: guard.session.user.id`, which the member-timeline filter
matches, so moving them to `family` publishes each row on the **acting
officer's** own activity page. The names in the row travel in `metadata`, which
the member projection withholds. It is the smallest widening on this page and
still a widening.

## How to check this page is still true

`npm run audit:census` prints the live distribution, and
`src/lib/__tests__/audit-writer-census.test.ts` fails CI if it moves without the
manifest moving with it. The numbers this page was written against:

```
row-producing sites:  427
uncategorised:        0
category values: admin 96, booking 101, xero 34, family 34, payment 33,
                 lodge 52, account 20, security 19, privacy 19,
                 communication 14, system 4
```
