# AI Diagnostics — typed structured page context

> Part of the [AI Diagnostics hub](README.md) and the
> [documentation hub](../README.md).

Audience: Developer, Agent (with an Operator section on the personal-detail
opt-in).

When an admin asks AI Diagnostics a question, the assistant needs to know which
page they are looking at. This is how it finds out — **safely**. The browser
sends a small, strictly typed **selector** naming a registered page and, at most,
one record id. The server then re-reads everything itself. Nothing the browser
says is ever treated as a fact.

Delivered by AID-4 (issue #2373) of epic #2369. The contracts it implements are
[ADR-001](decisions/ADR-001-separate-admin-only-diagnostics-product.md) §2 (no
DOM scraping, no screenshots),
[ADR-002](decisions/ADR-002-admission-and-per-tool-authorization-lattice.md)
(fresh per-call `area:view`, AND across areas),
[ADR-003](decisions/ADR-003-untrusted-evidence-classes.md) (untrusted evidence,
observed-at, citation) and
[ADR-004](decisions/ADR-004-sensitive-context-retention-redaction-audit-metadata.md)
(opt-in personal detail, redaction, approved audit metadata).

## The one rule: a client value SELECTS, it never ASSERTS

The member-facing Page help assistant takes a flat free-text `pageContext`
string that the browser composes and the server forwards verbatim
(`src/components/help-widget/help-page-context.ts`). That is fine there — Page
help has no tools and no data. Diagnostics has both, so it cannot work that way,
and [ADR-001](decisions/ADR-001-separate-admin-only-diagnostics-product.md) §1
forbids it from reusing that plumbing as its policy surface. **Page help is
unchanged by this work.**

Diagnostics instead takes a typed selector:

| Field | What it is | Bound |
| --- | --- | --- |
| `routeKey` | A key in the server-side registry, e.g. `admin.member-detail`. Never a pathname. | 64 chars, `a-z0-9` with `.`/`-` |
| `recordId` | An opaque record id the page is showing. The **server** decides what kind of record that is. | 64 chars, `A-Za-z0-9_-` |
| `tab`, `step`, `status`, `errorCode` | View tokens, each checked against **that route's** allowlist. | 48 chars each |
| `filters` | Allowlisted filter keys with bounded values. The only free text in the whole selector. | 8 filters, keys 32, values 120 chars |
| `includeSensitiveRecord` | The operator's explicit opt-in to include the record's identifying fields. Default off. | boolean |

Anything else is rejected. The schema is `.strict()`, so an unknown key is a
refusal rather than something quietly ignored — that is what stops a future
client opening a second serialization channel through this object.

The schema itself is **module-private to `parse.ts`**, and that is a security
property rather than tidiness. A strict object schema is not total on its own: zod
accepts a `JSON.parse`-created `__proto__` own property and silently strips it,
reporting no unknown key at all. An exported schema would therefore be a second
door that repairs a selector this layer is required to refuse, so
`parseDiagnosticsPageSelector` is the only way in — and the resolver takes the
selector as `unknown` for the same reason, so no caller needs the schema anyway.

## How a resolution runs

`resolveDiagnosticsPageContext` (`src/lib/diagnostics/page-context/resolve.ts`)
runs four gates, in this order, and never throws for an input or permission
problem — every failure is a structured, evidence-free result.

1. **Parse** (`parse.ts`) — reserved keys, then the structural schema, then the
   route's own allowlists. Rejection is **total**: a selector with one bad token
   is refused outright rather than having that token silently dropped, and the
   failure codes name the *field*, never the value, so a rejected selector cannot
   use the error path as an output channel. `__proto__` is refused explicitly on
   the raw input, because zod's `record` cannot see it and would drop it rather
   than reject it — a silent drop is the partial rejection this layer forbids.
2. **Authorize** (`authorize.ts`) — the caller's effective permission matrix is
   re-read **from the database-joined access roles on every single resolution**,
   exactly as `/api/help/chat` does for its surface downgrade. Never the JWT,
   never a session copy, never a cache. A route that declares two areas needs
   `view` on **both** (AND, never OR). The same read also checks the account state
   the rest of the admin surface checks — `requireAdmin` refuses a member who is
   deactivated (`active = false`, which is what the members screen's deactivate
   action writes, leaving `canLogin` untouched) or under a forced password change,
   and so does this. Any fault reading the roles denies, and the three ways it can
   fail stay distinct in the resolved context's `reason`: a missing member
   (`actor_unresolved`), a locked-out account (`actor_blocked`) and an unreadable
   role graph (`actor_read_failed`) are different events, and the caller is told
   which one happened. The **audit rows of all three are byte-identical**, and
   deliberately so: ADR-004 §4's approved metadata list is closed and carries no
   failure-reason field, so `DiagnosticsPageContextAudit` has none, and widening
   that list is an ADR-004 amendment and an owner decision. The distinction is
   carried on `reason` for the caller to act on, and it is disclosed to the model
   in the rendered evidence block (`no page context was retrieved (reason: …)`), so
   separating a database outage from an ordinary lock-out means reading the
   resolved context, not the audit row alone. The two-factor gate is
   deliberately NOT here: it decides on session facts no member row carries, so it
   stays with `requireAdmin` on the route AID-7 (#2378) builds.
3. **Re-fetch** (`projections.ts`) — a fixed, typed, column-allowlisted read of
   the one record, by id. No dynamic columns, no caller-influenced filter, no
   model-authored SQL.
4. **Bound** — **every** fact is hard-capped, free text is redacted
   (`redactSensitiveText`) first, the whole result is stamped with an observed-at
   instant, and the approved audit metadata is attached.

There are exactly three fact constructors in `projections.ts` and no fourth way
to add one: `derivedFact` for closed-vocabulary server values (enum, boolean,
count, integer cents, date), `textFact` for non-identifying free text such as a
lodge name, and `sensitiveFact` for identifying free text. The two free-text
constructors share one redact-then-cap path. `derivedFact` deliberately skips
redaction — the redactor treats a standalone run of eight or more digits as
phone-like, which would rewrite a large integer-cents amount to `[REDACTED]` —
so it **verifies** the closed-vocabulary shape instead and falls back to the
redact-and-cap path for anything else. That verification is a union of the exact
shapes the server itself builds (a `SCREAMING_SNAKE` Prisma enum token, a signed
integer, `yes`/`no`, a `yyyy-mm-dd` lodge day, an ISO instant), each capped at 64
characters. It is deliberately not one permissive character class: a class wide
enough to cover all five in a single pattern also covers `sk_live_…`, `whsec_…` and
`Bearer …`, so the one mistake the check exists to catch would have shipped a
secret verbatim. The check is not a general safety net, though: a value that is
uppercase alphanumeric (an AWS access-key id, a base32 TOTP secret) or all
digits (a phone, IRD or card number) matches the enum or integer shape and
travels raw, bounded only at 64 characters — unavoidable, because redaction's
digit-run heuristic would rewrite an eight-digit cents amount. The real control
is each reader's explicit column allowlist: a free-text column reaches
`derivedFact` only if someone adds it there, and a column whose values can be
uppercase alphanumeric or all digits must use `textFact` or `sensitiveFact`
instead.

## The route registry

`src/lib/diagnostics/page-context/registry.ts` is the entire allowlist. Every
token list on a route **defaults to empty, and an empty list refuses the field**
— so adding a page starts from "no tabs, no steps, no statuses, no error codes,
no filters, no record" and widens one field at a time.

| Route key | Page | Areas required (all of them) | Record kind |
| --- | --- | --- | --- |
| `admin.dashboard` | `/admin/dashboard` | `overview` | — |
| `admin.bookings` | `/admin/bookings` | `bookings` | booking |
| `admin.booking-approvals` | `/admin/booking-approvals` | `bookings` | booking |
| `admin.waitlist` | `/admin/waitlist` | `bookings` | booking |
| `admin.bed-allocation` | `/admin/bed-allocation` | `bookings` **and** `lodge` | — |
| `admin.members` | `/admin/members` | `membership` | member |
| `admin.member-detail` | `/admin/members/[id]` | `membership` | member |
| `admin.payments` | `/admin/payments` | `finance` | payment |
| `admin.stuck-states` | `/admin/stuck-states` | `support` | — |
| `admin.setup` | `/admin/setup` | `support` | — |
| `admin.setup-finance` | `/admin/setup/finance` | `finance` | — |
| `admin.health` | `/admin/health` | `support` | — |

Four drift guards keep this table honest, all in
`src/lib/diagnostics/page-context/__tests__/registry.test.ts`:

- **Never weaker than the admin UI.** Each `pathname` is resolved through
  `getAdminRouteRequirement` and the lattice's own area must appear in
  `requiredAreas`. Page context can never become a side channel around the
  permission the admin page itself enforces.
- **Every step's own sub-path too.** A `steps` token here names a sub-page — the
  guided-setup wizard links out to one route per step — so each `pathname/step` is
  resolved the same way. This is not hypothetical: `/admin/setup/finance` is gated
  on `finance` while its parent is gated on `support`, so it is not a step of the
  wizard row at all. It has its own row above, gated exactly as the page is.
- **Status vocabularies track the database.** The booking and payment status
  token lists are asserted equal to the `BookingStatus` and `PaymentStatus`
  Prisma enums, so a schema change cannot leave a stale vocabulary behind.
- **The stuck-state severities track their union.** `StuckStateSeverity` is a
  hand-written TypeScript union rather than a generated enum, so the registry pins
  the forward direction with `satisfies` at compile time and the test pins the
  reverse — a fourth severity cannot be added without this list gaining it.

**Filter keys are the page's real query parameters**, and a deliberate subset of
them: pagination and sort keys are excluded because they say nothing about why a
page shows what it shows. Because rejection is total, a client must send only
allowlisted keys — one unlisted key costs the operator their whole page context, so
this is a contract AID-7 (#2378) builds against, not a hint.

Unlike the four guards above, the filter keys are **not** pinned by a test. Each
page reads its parameters its own way — a typed `searchParams` object on a server
page, `useSearchParams().get(...)` on a client one, a zod query schema on an API
route — so any assertion strong enough to catch drift would have to parse page
source, and would break on a refactor that changed nothing real. They are derived
by hand instead, and each row records where its keys came from. Drift here costs an
operator their page context on that page; it cannot widen what is read, because the
filter values are never used as a query — they are re-emitted as the operator's own
selection and nothing else.

### Adding a page

1. Add a row with `requiredAreas` matching (or exceeding) the admin route
   lattice, and every token list left empty.
2. Widen one field at a time, with a reason.
3. If it takes a record, use an existing record kind or add a reader in
   `projections.ts` with an explicit column allowlist and an opt-in split.
4. Update this table and the tests.

## What is actually re-read

Each record kind has one reader with a fixed column allowlist. The **kind comes
from the registry, never from the client** — which is what makes an
id-substitution attempt inert: a member id supplied on a bookings page can only
fail to find a booking; it can never resolve a member.

| Kind | Always (non-identifying) | Only with the operator's opt-in |
| --- | --- | --- |
| `booking` | status, check-in / check-out (NZ date-only), nights, guest count, lodge name, deleted, requires-admin-review, admin review status, created-at | member name, notes |
| `member` | active, can-login, email-verified, age tier, created-at | name |
| `payment` | status, source, amount / refunded / credit-applied in **integer cents**, created-at | payer name |

Every value in either column is capped at 200 characters, and the free-text ones
(lodge name, notes, names) are redacted first — `Lodge.name` is a plain,
unbounded `String` an admin types, so it gets the same treatment as a note even
though it identifies nobody.

Deliberately **not** projected at any level: money on a booking (a finance
question belongs to the finance tools, AID-6C #2377), member contact details
(email, phone, addresses — a membership question belongs to AID-6B #2376),
credentials, review notes, and raw provider payloads.

## Operators: the personal-detail opt-in

By default the assistant is told the **state** of the record you are looking at
— is this booking confirmed, how many nights, which lodge — and nothing that
identifies a person. If you need the assistant to talk about the person, tick
**"Include this record's personal details"**. That includes the identifying
fields of **that one record only**, and only if you already have permission to
see them. When you leave it off, the assistant is explicitly told "personal
detail omitted", so it says so rather than guessing.

The exact wording lives in `DIAGNOSTICS_SENSITIVE_INCLUSION_COPY`
(`src/lib/diagnostics/page-context/types.ts`) so the Diagnostics shell (AID-7,
#2378) renders the same words the server enforces.

## The evidence block

`renderPageContextEvidenceBlock` (`render.ts`) produces the block that goes to
the model. It is the page-context counterpart of the knowledge bundle's
`renderSourceEvidenceBlock`, and it has four properties:

- **Evidence channel only.** It belongs in the **user turn**. It must never be
  placed in, concatenated into, or interpolated into the system role — the
  frozen system prompt is what keeps caller-derived text out of the system role
  (`src/lib/anthropic-client.ts`). AID-7 owns that assembly, and the module's
  only assembly helper, `buildPageContextUserTurn`, hands back a turn already
  marked `role: "user"`, so putting page context in the system role takes a
  deliberate act of stripping the role off.
- **Two classes, labelled apart.** *Operator selection* is what the person has
  on screen — a claim about their view. *Server-verified facts* were re-read
  from the database at the observed-at instant. Collapsing the two would let a
  client-chosen filter string read like a system fact.
- **Delimiters cannot be forged.** Angle brackets are stripped from every
  untrusted span, the wrapper token itself is defused, and newlines are
  collapsed so a value cannot fake a new line or a new section.
- **Bounded and deterministic.** No clock, no randomness, a hard character cap,
  and the closing tag is never the thing that gets cut. The cap takes the tail,
  so section order is itself a safety property: framing, page identity and the
  omission notices render **before** the evidence. A large database column can
  therefore only ever cost facts — never the notice saying what was withheld.

A denial and an unavailable result still render: "there is no page context and
here is why" is the answer that stops the model inventing one.

## What is written down

Nothing about the page or the record is persisted by this layer. The resolved
context carries a separate `audit` object holding only the approved metadata of
[ADR-004](decisions/ADR-004-sensitive-context-retention-redaction-audit-metadata.md)
§4 — route key, areas checked, allowed/denied, record kind, a **sha256 hash** of
`kind:id` (never the raw id), fact count, byte count (measured over the resolved
selection-plus-facts payload, not over any particular rendering of it), and the
observed-at instant. No fact values, no names, no prompt, no answer. It is a separate object
precisely so a caller that persists an audit row cannot accidentally persist a
field value.

**The audit describes the attempt, not the result.** The record kind and hash
come from the lookup that was *attempted* — the server-chosen kind plus the
validated id — so a lookup that missed or failed records the same reference a
successful one would, differing only in its fact count. Deriving them from the
result instead would make id enumeration through this path unattributable,
because almost every probe in such a sweep is a miss. For the same reason the
route key and areas checked survive an exit that withholds the route from the
*evidence*: an actor that could not be established is told nothing, but the row
still says which surface was hit — and the same holds one gate earlier, where a
selector whose route resolved cleanly but whose token failed that route's allowlist
still audits the route. Without that, a sweep probing the allowlists would look
like junk aimed at no page, while the equivalent sweep using a valid token and bad
record ids is fully attributable.

## Known limits

- **The reads run on the application's Prisma client today.** ADR-007's
  dedicated non-superuser SELECT-only role is the substrate AID-5 (#2374)
  builds; these readers move onto it when it lands. That is defence in depth
  *beneath* — never a substitute for — the fixed column allowlists here and the
  fresh `area:view` gate, and ADR-007 §2 says so explicitly.
- **The registry is small on purpose.** A page belongs here when an operator
  plausibly asks "why is this page showing me this?", not merely because it
  exists. Every row is a place personal data could be re-read.

## Related links

- Hub: [AI Diagnostics](README.md)
- [Threat model](threat-model.md) — trust boundaries TB1/TB2/TB3 and the
  information-disclosure rows.
- [ADR-002](decisions/ADR-002-admission-and-per-tool-authorization-lattice.md),
  [ADR-003](decisions/ADR-003-untrusted-evidence-classes.md),
  [ADR-004](decisions/ADR-004-sensitive-context-retention-redaction-audit-metadata.md),
  [ADR-007](decisions/ADR-007-least-privilege-select-only-database-credential.md)
- [`docs/agents/PROMPT_INJECTION_GUIDE.md`](../agents/PROMPT_INJECTION_GUIDE.md)
- [`docs/SECURITY.md`](../SECURITY.md)
