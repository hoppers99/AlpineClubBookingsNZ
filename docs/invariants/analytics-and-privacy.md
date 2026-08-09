# Analytics And Privacy

Audience: Developer, Agent.

Prefix defined in this file: **`INV-PRIV`** — analytics loading and consent, what
this application is allowed to send to Google, what a visitor's choice does, and
what personal data may appear in a log.

Read this file when you are changing analytics loading, the consent banner or the
public Analytics preferences control, the analytics route policy, anything that
decides what leaves this application for Google, or the log/Sentry redactor and
what it strips out.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

## INV-PRIV-001

Google Analytics must not load unless ALL of the following hold (#2573):

- the Analytics module is enabled at Admin → Modules (the master switch);
- a valid GA4 measurement id is stored in `AnalyticsSettings` — the database is
  the sole canonical source, `NEXT_PUBLIC_GA_MEASUREMENT_ID` is not read
  anywhere at runtime, and there is no fallback to it;
- the route is analytics-eligible under the fixed, application-controlled policy
  in `src/lib/analytics-route-policy.ts`; and
- the visitor has explicitly accepted, **whenever the consent banner is
  enabled**.

## INV-PRIV-002

While the banner is enabled and no accepted choice is recorded at the club's
current consent revision, nothing at all reaches Google: no tag load, no
request, no cookieless ping and no consent-status signal. Declining or
dismissing the banner both count as denied.

## INV-PRIV-003

While the banner is disabled the tag loads automatically on eligible routes, a
decline recorded *while the banner was showing* is invalidated once, and a
subsequent opt-out through the public Analytics preferences control is honoured
at any consent revision — so the preferences control can never be made
ineffective by turning the banner off.

## INV-PRIV-004

Advertising storage, advertising user data and advertising personalisation are
denied in every consent signal, in both banner modes, with no setting that
changes it.

## INV-PRIV-005

Every page view **this application sends** carries `origin + pathname` only, and
is sent only for an eligible route. Never a query string, never a fragment, and
never a reset token, invitation token, verification code, PIN, email address,
member id, booking id or payment id — including in the referrer, which is
sanitised before Google sees it.

## INV-PRIV-006

It sends **exactly one such page view per address** across client-side
navigation: `send_page_view: false` suppresses the one the `config` call would
send, and the manual event is de-duplicated against the last location actually
sent.

## INV-PRIV-007

**Both of those hold end to end only if the GA property's enhanced-measurement
option “Page changes based on browser history events” is switched off.** It is a
Google-side setting, on by default for a new web stream and not controllable from
`gtag`, and it works by watching the browser's own history rather than by asking
the application — so with it on Google adds a page view of its own on every soft
navigation, including the navigation that LEAVES the public website for an
excluded route. Next flips the URL in `HistoryUpdater`'s `useInsertionEffect`
(the commit's mutation phase, `next@16.2.12`), while the runtime's kill switch is
a passive effect destroy React schedules after paint, so the resident tag
observes `/login`, `/dashboard` or `/book` while `ga-disable-<id>` is still
false. Whether the resulting hit carries the browser's raw URL or inherits the
sanitised value already `set` on the tag is Google's internal behaviour and is
not verifiable from this repository; under either reading a page view leaves for
an address the policy excludes. The setup panel and `docs/guides/integrations.md`
therefore make switching it off a REQUIRED setup step, and state the disclosure
rather than the double count as the reason. The application cannot switch it off
itself, which is why this is a documented operator obligation and not an
enforced invariant.

## INV-PRIV-008

Leaving the public website is part of the same guarantee. The runtime is mounted by
the public website layouts only, so a soft navigation into the member, admin or
login/recovery groups unmounts it — and because neither that unmount nor removal of
an injected script node can unload an executed library (and Next may retain the node
for the document), the unmount sets Google's per-id kill switch and queues a denial.
A visitor's opt-out is propagated to other open tabs the same way, over the `storage`
event.

## INV-PRIV-009

The per-browser choice (`analytics-consent.v2`) stores the applicable consent
revision and which surface recorded it, and is honoured on revisit. Only the
explicit “Ask visitors to choose again” admin action bumps the revision; an
ordinary settings save never does. Every read and write of the configuration is
permission-checked server-side, every change is audit logged, and a save
invalidates the public configuration cache so a removed or invalid measurement
id can never leave a stale tag active.

## INV-PRIV-010

Every one of these fails CLOSED: a missing row, an invalid measurement id, a
disabled module or a database read failure all mean no analytics, and the public
website still renders normally.

## INV-PRIV-011

What personal data may appear in a log, and what an audit row is allowed to keep.
These are two different answers on purpose, and neither is "none".

- **The log/Sentry redactor strips person fields BY KEY NAME, and its coverage
  is therefore not exhaustive.** `src/lib/redact-sensitive-json.ts` is what every
  log line and every Sentry event passes through — pino's `log` formatter in
  `src/lib/logger.ts`, and `beforeSend`/`beforeBreadcrumb` in all THREE Sentry
  surfaces (`src/instrumentation-client.ts`, `sentry.server.config.ts`,
  `sentry.edge.config.ts`; the server one is the one that sees Prisma member
  objects). It redacts, by key: first, last, middle and given names and the
  composed spellings a route invents (`fullName`, `memberName`, `guestName`,
  `contactName`, `surname`, `familyName`); street and postal address including
  Xero's own bare `City`/`Region`/`Country`/`PostalCode`; date of birth; gender;
  occupation; email; phone; credentials including hashed and second-factor ones;
  and payment identifiers.
- **A key spelling it does not know is a leak, so this list is a floor and not a
  guarantee.** Emails and phone numbers have a second, value-shaped net, so a
  missed key name still cannot leak one of those. Names and addresses have NO
  such fallback — nothing about the string "12 Example Street" identifies it as
  an address — so for those the key name is the only defence. A call site that
  composes a person's name into a key the list does not carry defeats it
  entirely, which is what #2683 found in five places (a family group's name, a
  Xero import result, a webhook payload spread, a minor's name on a
  member-facing route, and the nightly hut-leader cron). Those are fixed at
  source. **When you add a call site that logs a person, log the identifier.**
- **`name` is deliberately NOT on the denylist**, neither as an exact key nor as
  a fragment. It is the key for lodges, rooms, membership types, email
  templates, modules, fee schedules and Xero contact groups, and the admin Xero
  operations panel reads group names straight out of an already-redacted
  payload, so redacting it would blank operational logs and live admin UI. Where
  a person's `name` genuinely must be SENT — Xero's API requires `Name` on a
  contact — it is stripped at the persistence boundary instead, so the outbound
  request carries it and `XeroSyncOperation.requestPayload` does not
  (`stripPersonNameFromStoredContactPayload` in `src/lib/xero-contacts.ts`).
- **Audit rows deliberately keep MORE than a log line does: first name, last
  name and street address.** The admin-action audit trail is written through
  `src/lib/audit.ts` (`logAudit`, `createAuditLog`, `createStructuredAuditLog`),
  whose `details` and `metadata` are sanitised by `sanitizeAuditMetadata` and
  `sanitizeAuditArchiveText` — a different key list, which redacts credentials,
  tokens, card numbers and long HTML but NOT person fields. Owner decision of
  9-10 Aug 2026 on #2683: an `AuditLog` row is a permission-gated,
  retention-classed evidence record whose job is to say who did what to whom, so
  "who" has to be legible to the officer reviewing it; this schema holds no
  special-category data (a check across all 172 models found no medical,
  dietary, emergency-contact, next-of-kin or ethnicity field), and the file's own
  ARCHIVE MODE note records that over-redaction had already destroyed the only
  surviving copy of a club's email wording. `src/lib/__tests__/audit.test.ts`
  pins all three fields, in both directions at once.
- **The boundary is the module, not the caller's intent.** A value keeps a person
  field only by being written as an audit row through `audit.ts`. Anything that
  reaches `logger.*`, Sentry, a webhook log or a persisted Xero payload goes
  through the redactor and loses it, whatever the calling code believes its
  context to be. There is no "audit context" switch on the redactor for a later
  change to copy, so the exception cannot spread by imitation; widening it means
  moving a call onto the audit writer, which is a visible change carrying its own
  permission and retention consequences.
- **The redactor has two limit profiles, and the difference is load-bearing.**
  `redactSensitiveJson` is the log path: depth 6 and an output budget, because a
  log line must stay cheap. `redactSensitiveRecord` is the stored-or-displayed
  path — `sanitizeForJson` in `src/lib/xero-sync.ts` and the admin Xero panels —
  and drops those limits, because those payloads are persisted records that
  read-modify-write cycles re-read and re-persist, so a truncation there is
  permanent and compounds. Both apply exactly the same redaction rules.
- **A key added to the denylist must never be broad enough to rewrite an
  identifier.** The value-shaped phone pattern is bounded so that an 8+ digit run
  inside a cuid survives, because those ids are load-bearing in persisted
  payloads. The email pattern excludes path separators for the same reason: it
  used to match `node_modules/@sentry/nextjs/…` and replace every stack trace
  naming a scoped package with `[REDACTED]`. The same caution governs every key
  fragment added later — which is why `region`, `country` and `city` are exact
  keys rather than fragments, and why `token` is not a fragment at all.
