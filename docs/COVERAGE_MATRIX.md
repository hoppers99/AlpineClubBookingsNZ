# Documentation Coverage Matrix

Audience: Developer, Agent (workplan input)

This matrix enumerates **every admin route area** under
`src/app/(admin)/admin/*` and records, for each, the reference documentation
that exists today and whether a dedicated **operator guide** (per the skeleton
in [`STYLE_GUIDE.md`](STYLE_GUIDE.md)) exists yet.

It is the authoritative workplan input for the operator-guide programme (issue
#2050). "Reference coverage" means architecture/runbook prose that describes the
behaviour; it is **not** the same as a task-focused operator guide with
screenshots. Almost every area therefore shows an operator-guide **GAP** today —
that is expected: #2049 lays the foundation and #2050 fills the gaps.

The area list is generated from the actual route directories (68 areas,
excluding `__tests__`), so it is exhaustive and will not silently miss a
surface. When a new admin area is added, add a row here in the same PR (this is
part of the docs-lockstep rule in `AGENTS.md`).

## How to read the columns

- **Area** — the route directory, i.e. `/admin/<area>`.
- **Permission area** — the `ADMIN_PERMISSION_AREAS` bucket it resolves to (see
  `ARCHITECTURE.md` → "Admin and Lodge"). Useful for grouping guides.
- **Reference coverage** — existing doc(s) that describe the behaviour, or `—`.
- **Operator guide** — `GAP` (no guide yet, planned in #2050), or a link once
  the guide lands.

## Matrix

| Area (`/admin/…`) | Permission area | Reference coverage | Operator guide |
| --- | --- | --- | --- |
| `access-roles` | support | `ARCHITECTURE.md` (access roles / definitions) | GAP |
| `age-tier-settings` | bookings | `ARCHITECTURE.md`, `AUTHORITATIVE_FEES.md` | GAP |
| `appearance` | content | — | GAP |
| `audit-log` | support | `AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` | GAP |
| `background-jobs` | support | `ARCHITECTURE.md` (Cron Jobs) | GAP |
| `bed-allocation` | bookings | `ARCHITECTURE.md` (bed allocation), `CAPACITY_MODEL.md` | GAP |
| `book` | bookings | — (admin book-on-behalf) | GAP |
| `booking-approvals` | bookings | `STATE_MACHINES.md` | GAP |
| `booking-change-requests` | bookings | `STATE_MACHINES.md` | GAP |
| `booking-messages` | support | — | GAP |
| `booking-policies` | bookings | `ARCHITECTURE.md` (booking policies), `CANCELLATIONS.md` | GAP |
| `booking-requests` | bookings | `ARCHITECTURE.md` (public booking requests) | GAP |
| `bookings` | bookings | `ARCHITECTURE.md` (booking/payment flow), `STATE_MACHINES.md` | GAP |
| `bookings-setup` | bookings | — | GAP |
| `chores` | lodge | — | GAP |
| `committee` | membership | `ARCHITECTURE.md` (committee roles/assignments) | GAP |
| `communications` | membership | `src/lib/email-message-registry.ts` | GAP |
| `config-transfer` | support | `config-transfer/README.md` (planned feature) | GAP |
| `dashboard` | overview | `ARCHITECTURE.md` (Needs Attention / badges) | GAP |
| `deletion-requests` | membership | `ARCHITECTURE.md` (member lifecycle delete) | GAP |
| `display` | content | `lobby-display/README.md`, `lobby-display/operating.md` | Feature hub (extend in #2050) |
| `email-deliverability` | support | `ARCHITECTURE.md` (email), email registry | GAP |
| `email-messages` | support | `src/lib/email-message-registry.ts` | GAP |
| `family-groups` | membership | `ARCHITECTURE.md` (family groups / billing) | GAP |
| `family-suggestions` | membership | `ARCHITECTURE.md` (hidden family suggestions) | GAP |
| `fee-configuration` | finance | `AUTHORITATIVE_FEES.md` | GAP |
| `fees` | finance | `AUTHORITATIVE_FEES.md` | GAP |
| `health` | support | — | GAP |
| `hut-leaders` | lodge | `ARCHITECTURE.md` (hut-leader auto-assign cron) | GAP |
| `image-manager` | content | — | GAP |
| `induction` | membership | — | GAP |
| `integrations` | support | `CONFIGURATION.md`, `DEPLOYMENT.md` | GAP |
| `internet-banking` | finance | `ARCHITECTURE.md` (Internet Banking), `xero/ARCHITECTURE.md` | GAP |
| `issue-reports` | support | `ARCHITECTURE.md` (issue reports / stuck states) | GAP |
| `lockers` | membership | — | GAP |
| `lodge` | lodge | `ARCHITECTURE.md` (lodge kiosk / operations) | GAP |
| `lodge-instructions` | lodge | `src/lib/token-catalogue.ts`, `PUBLIC_PAGE_CONTENT_TOKENS.md` | GAP |
| `lodges` | lodge | `multi-lodge/README.md`, `multi-lodge/feature-overview.md` | Feature hub (extend in #2050) |
| `member-applications` | membership | `ARCHITECTURE.md` (membership application / nominations) | GAP |
| `member-fields` | membership | — | GAP |
| `members` | membership | `ARCHITECTURE.md` (members, CSV import, roles) | GAP |
| `membership-cancellation` | membership | `CANCELLATIONS.md` | GAP |
| `membership-cancellations` | membership | `CANCELLATIONS.md`, `ARCHITECTURE.md` (cancellation review queue) | GAP |
| `membership-setup` | membership | `ARCHITECTURE.md` (membership types) | GAP |
| `membership-types` | membership | `ARCHITECTURE.md` (seasonal membership types) | GAP |
| `modules` | support | `CONFIGURATION.md` (module flags) | GAP |
| `mountain-conditions` | content | — | GAP |
| `notification-recipients` | support | `ARCHITECTURE.md` (email / notifications) | GAP |
| `notification-rules` | support | `ARCHITECTURE.md` (email / notifications) | GAP |
| `notifications` | support | email registry, `ARCHITECTURE.md` (email) | GAP |
| `page-content` | content | `PUBLIC_PAGE_CONTENT_TOKENS.md` | GAP |
| `payments` | finance | `ARCHITECTURE.md` (Stripe), `finance-dashboard/README.md` | GAP |
| `promo-codes` | bookings | `ARCHITECTURE.md` (promo codes / redemptions) | GAP |
| `refund-requests` | finance | `CANCELLATIONS.md`, `ARCHITECTURE.md` (refund recovery) | GAP |
| `reports` | finance | `finance-dashboard/README.md` | GAP |
| `rooms-beds` | lodge | `CAPACITY_MODEL.md`, `ARCHITECTURE.md` (bed inventory) | GAP |
| `roster` | lodge | `ARCHITECTURE.md` (roster/chores) | GAP |
| `seasons` | bookings | `ARCHITECTURE.md` (seasons / season rates) | GAP |
| `security` | support | `SECURITY.md`, `docs/SECURITY.md` | GAP |
| `setup` | support | `CONFIGURATION.md`, `IMPLEMENTATION_GUIDE.md` | GAP |
| `site-banners` | content | `ARCHITECTURE.md` (SiteBanner) | GAP |
| `site-content` | content | `PUBLIC_PAGE_CONTENT_TOKENS.md` | GAP |
| `site-style` | content | — | GAP |
| `stuck-states` | support | `ARCHITECTURE.md` (stuck-state dashboard) | GAP |
| `subscription-lockout` | finance | `ARCHITECTURE.md` (subscription lockout) | GAP |
| `subscriptions` | finance | `ARCHITECTURE.md` (membership subscription billing) | GAP |
| `waitlist` | bookings | `ARCHITECTURE.md` (waitlist), `E2E_PLAYWRIGHT.md` | GAP |
| `work-parties` | lodge | — | GAP |
| `xero` | finance | `xero/ARCHITECTURE.md`, `XERO_MEMBER_GROUPING_RUNBOOK.md` | GAP |

## Summary

- **68** admin route areas total.
- **2** areas are already served by a **feature hub** (`display` → lobby-display,
  `lodges` → multi-lodge). #2050 should extend, not duplicate, those hubs.
- **~16** areas have **no reference coverage at all** (`—` above): `appearance`,
  `book`, `booking-messages`, `bookings-setup`, `chores`, `health`,
  `image-manager`, `induction`, `lockers`, `member-fields`,
  `mountain-conditions`, `site-style`, `work-parties`, and the thin
  `*-setup`/config surfaces. These are the highest-value operator-guide targets.
- **Every** area needs a task-focused operator guide (with screenshots) — none
  exist yet. That is the #2050 deliverable; this file is its checklist.

### Notes vs the ~20 gaps the initial audit named

The audit's gap list mapped cleanly onto real route dirs with two nuances worth
flagging for #2050 scoping:

- **"school-bookings" is not its own route area.** School group handling is a
  behaviour spread across `bookings`, `booking-requests`, and the
  `school-attendee-confirmations` cron (`ARCHITECTURE.md`), not a
  `/admin/school-bookings` page. Cover it as a cross-cutting topic within the
  bookings-cluster guide rather than expecting a standalone page.
- **"membership-types/setup" is two adjacent routes**, `membership-types` and
  `membership-setup` (plus `member-fields`). Decide in #2050 whether they are
  one guide or three; they share the Membership permission area.
- The audit under-counted: there are **68** areas, not ~20 — the ~20 was the
  "obviously uncovered" subset. This matrix is the exhaustive version.
