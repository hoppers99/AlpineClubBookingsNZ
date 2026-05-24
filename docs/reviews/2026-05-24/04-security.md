# Track 4 - Security review

## Summary
- Files reviewed: ~45 (all changed API routes, token-related libs, email renderer, Stripe webhook, migrations)
- Findings: 0 critical, 0 high, 2 medium, 3 low/info
- Public-facing routes audited:
  - `POST /api/contact` (rate-limited, validated)
  - `GET /api/webhooks/stripe` (signature-verified)
  - `GET /membership-cancellation/[token]` (auth-required server component)
  - `POST /api/member/membership-cancellation-requests/confirm` (auth+rate-limited)
  - `POST /api/cron/payments` (CRON_SECRET with timingSafeEqual)
- Admin routes audited (all enforce `session.user.role !== "ADMIN"` and `requireActiveSessionUser`):
  - `booking-change-requests`, `booking-change-requests/[id]`
  - `communications/send`, `email-settings`, `email-templates`, `email-templates/preview`, `email-templates/reset`
  - `member-lifecycle-action-requests/[requestId]`
  - `members/[id]/lifecycle/archive`, `members/[id]/lifecycle/delete`, `members/export`, `members/bulk-update`
  - `membership-cancellation-requests`, `membership-cancellation-requests/[requestId]/participants/[participantId]`
  - `membership-cancellation-settings`, `notification-delivery-policies`
  - `roster/[date]`, `setup`, `chores/roster/[date]/print`

## Findings

### [MEDIUM] Confirmation token leaks into URL path and server logs
- **Location**: `src/app/(public)/membership-cancellation/[token]/page.tsx:43`, link generation in `src/lib/membership-cancellation-requests.ts:586`
- **Class**: Secret leakage (defence in depth)
- **Vulnerability**: The 256-bit confirmation token is placed in the URL path. URL paths are routinely captured by webserver access logs, reverse-proxy logs, Sentry/observability tooling, browser history, and the HTTP `Referer` header on any outbound link click from that page. Mitigation: the consumer route also requires an authenticated session whose `member.id === participant.memberId`, so a stolen token alone cannot be replayed by an attacker without first compromising that exact member's session. Risk is therefore reduced to log-disclosure scenarios where an internal actor with log access could see the token plus separately compromise the member.
- **Suggested fix**: Either accept the residual risk and document it (rationale: cookie-bound member check on consume), or move the token into a `?` query (Next still passes it through), strip it from logs via a `redact` rule, and avoid linking out from the public confirmation page so it does not appear in `Referer`. Token TTL (default short, see settings) further bounds exposure.
- **Commit**: 22bad90, 74ad857
- **Acceptance**: Pino logger redact list includes URL paths matching `/membership-cancellation/[^/]+`; or token moved to POST body / hash fragment.

### [MEDIUM] Email confirmation route binds token to logged-in user but does not invalidate other participant rows on confirmation
- **Location**: `src/lib/membership-cancellation-requests.ts:813-828`
- **Class**: Logic / state hardening
- **Vulnerability**: When a participant confirms or declines, only that participant's `confirmationTokenHash` is cleared. If a single member is (somehow) a participant on two overlapping cancellation requests (e.g. duplicate submission before validation closed the gap), the second token remains valid. This is not directly exploitable today because `createMembershipCancellationRequest` ought to refuse duplicates (`activeParticipant` check at line 256), but it's defence in depth.
- **Suggested fix**: When confirming, also null-out any other open `PENDING_CONFIRMATION` rows for the same `memberId`, or assert uniqueness in DB.
- **Commit**: 22bad90
- **Acceptance**: Test that a member with two PENDING_CONFIRMATION rows cannot confirm one and then use the other.

### [LOW] Public-page token URL persists after token clears
- **Location**: `src/app/(public)/membership-cancellation/[token]/page.tsx`
- **Class**: UX/info-disclosure
- **Vulnerability**: After a member confirms or declines, the URL still contains the token (now-cleared). A subsequent visitor with the URL gets a generic "invalid or already used" message, which is fine. No active vulnerability.
- **Suggested fix**: None required. Optional: server-side redirect to `/profile` after success.
- **Commit**: 22bad90
- **Acceptance**: N/A (informational).

### [LOW] Age-up parent email handoff sends parent's email content to recipient address held in DB without re-validation
- **Location**: `src/lib/cron-age-up.ts:106-151`, send at `:299`
- **Class**: Info exposure
- **Vulnerability**: `resolveAgeUpParentEmailHandoff` chooses `inheritEmailFrom.email`, `parent.email`, or a shared-login email match. If a parent's `email` field has been tampered with via an upstream admin edit, the youth's identifying details ("Member <firstName> <lastName>") are sent to that address. Standard mailing risk, not exploitable externally - any attacker would need admin write to set the wrong email. No token in the handoff email (verified at lines 297-309), so there's no account takeover vector. Audit row is written at `:174`, so it's traceable.
- **Suggested fix**: None required. The audit log captures `recipientEmail`, which is enough for traceability.
- **Commit**: 377947a
- **Acceptance**: Existing audit row sufficient.

### [LOW] PII in admin response payload
- **Location**: `src/lib/membership-cancellation-requests.ts:200-204` (`serializeRequest`)
- **Class**: PII exposure
- **Vulnerability**: Admin list/details for cancellation requests returns `email` and `ageTier` for every participant. This is required by the admin UI workflow (admin needs to identify and contact participants), so the exposure is justified. Member-side calls only hit `member/...` routes scoped to the requester's own family.
- **Suggested fix**: None.
- **Commit**: 22bad90, 7acb4de
- **Acceptance**: N/A.

## Confirmed-good

- **Tokens are crypto-strong and DB-hashed**. `src/lib/action-tokens.ts:13` uses `randomBytes(32).toString("hex")` (256-bit). Migration `20260524113000_membership_cancellation_confirmation_tokens` stores only `confirmationTokenHash` (sha256). Reuse of the proven `action-tokens` helper across `verification-tokens.ts`, `guest-chore-token.ts`, `nomination.ts`, and the new cancellation flow.
- **Token consumption requires both the token and the matching authenticated session**. `src/lib/membership-cancellation-requests.ts:782-787` returns 403 if `participant.memberId !== memberId`. Token is single-use (cleared on confirm/decline at lines 820/827).
- **TTL enforced** at lines 712-723 (preview) and 803-811 (consume). Migration includes `confirmationTokenExpiresAt` plus index.
- **Rate limiting on the public-token consume route**. `src/app/api/member/membership-cancellation-requests/confirm/route.ts:46-59` uses `rateLimiters.membershipCancellationConfirmation` (10 per 15 min). Submission also rate-limited via `membershipCancellationRequest` (3 per 24h).
- **Stripe webhook signature verification intact**. `src/app/api/webhooks/stripe/route.ts:57-77`: rejects missing header (400), calls `constructWebhookEvent` (which calls `stripe.webhooks.constructEvent` in `src/lib/stripe.ts`) before touching the body. The new payment-recovery and zero-dollar code (228f24e, ee46e2e) runs only inside the post-verification branch.
- **Idempotency on Stripe webhook**. Lines 84-90 atomically claim `ProcessedWebhookEvent` so replays are no-ops.
- **All new admin routes enforce role check**, not just auth. Each begins with `if (!session?.user || session.user.role !== "ADMIN")` followed by `requireActiveSessionUser`. Verified across all 32 changed `/api/admin/*` route files.
- **All new member-scoped routes verify ownership** before mutating, e.g. `src/app/api/bookings/[id]/change-requests/route.ts:159` `if (booking.memberId !== session.user.id && session.user.role !== "ADMIN")`.
- **CRON endpoint uses constant-time comparison**. `src/app/api/cron/payments/route.ts:9-18` uses `timingSafeEqual` and length-pre-check on `CRON_SECRET`.
- **Email template renderer escapes user-controlled values**. `src/lib/email-templates.ts:155-172` `plainTextEmailTemplate` calls `escapeHtml` on every block after token substitution. Admin-supplied override `bodyText` is plain text only - `validateEmailTemplateContent` (`src/lib/email-message-renderer.ts:185-191`) blocks raw HTML tags in submissions. `applyEmailMessageSettingsToHtml` escapes its replacement values (`src/lib/email-message-settings.ts:184`).
- **No `dangerouslySetInnerHTML` in any new tsx file**. Confirmed by grep across `src/`.
- **No new `$queryRawUnsafe` or `$executeRawUnsafe` over user-controlled values**. New raw-SQL usage is `pg_advisory_xact_lock(hashtext(${literal-key}))` via tagged-template `$executeRaw`, which is parameterised (e.g. `src/app/api/admin/roster/[date]/route.ts:156`, `src/lib/nomination.ts:362,369`). Pre-existing `$executeRawUnsafe` calls with a hardcoded string `SELECT pg_advisory_xact_lock(1)` carry no user input.
- **No raw token logging**. Confirmation token plaintext never appears in `logger.*`. Audit log records `participantMemberIds`, not tokens. Payment-recovery logs at `src/lib/payment-recovery.ts:185` log only IDs, not PII. `cron-age-up.ts:319,412` logs `memberId`, `firstName`, and `handoffReason` only.
- **Stripe payment intent IDs are not secret** (they appear in receipts) and may be logged.
- **CSRF posture is acceptable**. New mutating routes are API POST/PATCH/DELETE relying on the NextAuth session cookie (`SameSite=Lax` default in NextAuth v5), so a cross-site form submission would not carry the cookie. No JSON CSRF token is needed for cookie-bound POST endpoints that require an authenticated session and a body that browsers will not send cross-site by default. Public POST routes (`/api/contact`, `/api/webhooks/stripe`) do not depend on a session.
- **Password reset token (used in age-up) stored hashed** (`PasswordResetToken.tokenHash @unique` in `prisma/schema.prisma:341`).
- **Member export route is admin-only** (`src/app/api/admin/members/export/route.ts:38`) and supports filters.
- **Booking-change-request POST validates booking ownership and locked-period before opening request** (`src/app/api/bookings/[id]/change-requests/route.ts:159, 218`).
