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

Every person field — first name, last name, street and postal address, date of
birth, gender and occupation — is redacted before it can reach a log, and a
first name survives redaction in exactly one place:

- **The redactor redacts all of them, with no exception.**
  `src/lib/redact-sensitive-json.ts` is what every log line and every Sentry
  event passes through — pino's `log` formatter in `src/lib/logger.ts`, and
  `beforeSend`/`beforeBreadcrumb` in `src/instrumentation-client.ts` — and it
  also sanitises the Xero payloads persisted by `sanitizeForJson` in
  `src/lib/xero-sync.ts`. It takes no context parameter, and there is no flag,
  allowlist or key spelling that lets a first name through it.
- **The single exception is the admin-action audit trail**, written through
  `src/lib/audit.ts` (`logAudit`, `createAuditLog`,
  `createStructuredAuditLog`), whose `details` and `metadata` are sanitised by
  `sanitizeAuditMetadata` and `sanitizeAuditArchiveText` instead. An `AuditLog`
  row keeps a first name so that "who did what to whom" stays readable to the
  officer reviewing it. Owner decision of 9 Aug 2026 on #2683, taken against
  the blanket-redaction recommendation: this schema holds no special-category
  data (a check across all 172 models found no medical, dietary,
  emergency-contact, next-of-kin or ethnicity field), and a legible audit trail
  was judged worth more than a redacted forename inside a permission-gated,
  retention-classed database row. Stated precisely so this is not mistaken for
  coverage it does not claim: the audit writer's own key list redacts
  credentials, tokens and card numbers, not person fields, so an audit row whose
  caller chose to record a surname or an address still holds one. What this rule
  settles is the LOG path, which no longer does, and that a first name is the
  one person field the audit path is deliberately allowed to keep.
- **The boundary is the module, not the caller's intent.** A value keeps its
  first name only by being written as an audit row through `audit.ts`. Anything
  that reaches `logger.*`, Sentry, a webhook log or a persisted Xero payload
  goes through the redactor and loses it, whatever the calling code believes its
  context to be. There is no "audit context" switch for a later change to copy,
  so the exception cannot spread by imitation; widening it means moving a call
  onto the audit writer, which is a visible change carrying its own permission
  and retention consequences.
- **`name` is deliberately NOT on the redactor's denylist**, neither as an exact
  key nor as a fragment. It is the key for lodges, rooms, membership types,
  email templates, modules, fee schedules and Xero contact groups, and the admin
  Xero operations panel reads group names straight out of an already-redacted
  payload, so redacting it would blank operational logs and live admin UI. A
  call site that wants to record a person or a family therefore logs the
  identifier and never the `name`; person names are caught by the `firstname`
  and `lastname` key fragments instead.
- **A key added to the denylist must never be broad enough to rewrite an
  identifier.** The value-shaped phone pattern is bounded so that an 8+ digit
  run inside a cuid survives, because those ids are load-bearing in persisted
  payloads; the same caution governs every key fragment added later.
