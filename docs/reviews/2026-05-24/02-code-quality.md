# Track 2 - Code quality / readability

## Summary
- Files reviewed: 7 focus files plus ~15 spot-checks across the 196-file diff.
- Findings: 1 high, 9 medium, 6 low.

## Findings

### [HIGH] PUT handler in booking modify route is far too long
- **Location**: `src/app/api/bookings/[id]/modify/route.ts:104-1062`
- **Issue**: The `PUT` handler is ~960 lines and mixes auth, validation, capacity, pricing, promo-code reconciliation, guest CRUD, chore cleanup, payment/Xero settlement, audit, and email. Single-screen comprehension is impossible; the promo block alone (lines 417-561) has three intertwined branches with subtle ordering rules. The transaction callback (lines 142-877) is ~735 lines.
- **Suggested fix**: Extract helpers per concern: `resolveTargetDates`, `applyPromoCodeChanges`, `applyGuestChanges`, `applyPaymentAdjustments`, `applyLifecycleTransitions`. Most of these already have natural seams marked by the `// ---` block comments.
- **Commit**: 7932719

### [MEDIUM] Trivial top-level helper has unusual snake_case name and trivial body
- **Location**: `src/app/api/bookings/[id]/modify/route.ts:1064-1069`
- **Issue**: `booking_finalPriceCentsFromDiff` violates the project's camelCase convention, is exported nowhere, and only computes `result.booking.finalPriceCents - result.priceDiffCents`. Inlining the subtraction at the single call site (line 1026) is clearer than the function call, and the existing `booking.finalPriceCents` (pre-update) was already in scope as `booking.finalPriceCents` earlier in the transaction.
- **Suggested fix**: Inline the calculation, or capture `oldFinalPriceCents: booking.finalPriceCents` into the returned `result` object so the call site reads `result.oldFinalPriceCents`.
- **Commit**: 7932719

### [MEDIUM] No-op try/catch around guest validation
- **Location**: `src/app/api/bookings/[id]/modify/route.ts:266-271`
- **Issue**: The catch only re-throws either way (`if (error instanceof BookingGuestValidationError) throw error; throw error;`). The wrapper adds no behaviour and obscures the call path.
- **Suggested fix**: Remove the try/catch.
- **Commit**: 7932719

### [MEDIUM] Wrapper module adds nothing after refactor
- **Location**: `src/lib/booking-modify-permissions.ts:1-13`
- **Issue**: Both exports are one-line re-exports of `canModifyBookingStatusForRole` and `usesActiveBookingEditLifecycle` from `booking-edit-policy.ts`. Only two callers remain (`modify/route.ts`, `modify-quote/route.ts`), and one of them already imports `booking-edit-policy` directly. The renaming is the only thing the wrapper does.
- **Suggested fix**: Update the two callers to import from `booking-edit-policy` and delete the wrapper module.
- **Commit**: 7932719

### [MEDIUM] Duplicated helper functions across cancellation/lifecycle modules
- **Location**: `src/lib/member-lifecycle-actions.ts:95-128`, `src/lib/membership-cancellation-admin.ts:142-164`, `src/lib/membership-cancellation-requests.ts:158-178`
- **Issue**: `cleanText`, `memberName`, `serializeDate`, `serializeMember` are reimplemented in three files with near-identical bodies. `serializeMember` in `member-lifecycle-actions.ts` (lines 118-125) and `membership-cancellation-admin.ts` (lines 157-164) are byte-identical.
- **Suggested fix**: Move shared helpers into `src/lib/member-serialization.ts` (or similar) and import them. Keeps audit/serialization behaviour consistent if name formatting ever changes.
- **Commit**: 0988acb / 22bad90 / 7acb4de

### [MEDIUM] Duplicated participant include block
- **Location**: `src/lib/membership-cancellation-requests.ts:409-429, 532-550, 625-648, 829-865`
- **Issue**: The same Prisma `include` for cancellation participants (with the same nested member select) is inlined four times. One of them is even nested twice inside `respondToMembershipCancellationConfirmation`. Drift between these will silently change what the serializer returns.
- **Suggested fix**: Extract a `cancellationRequestInclude` constant `satisfies Prisma.MembershipCancellationRequestInclude` and reuse, mirroring the pattern already used in `membership-cancellation-admin.ts` (`adminCancellationRequestInclude`).
- **Commit**: 22bad90 / 74ad857

### [MEDIUM] Cast through `unknown` to side-step Prisma typing
- **Location**: `src/lib/membership-cancellation-settings.ts:90-111`
- **Issue**: `loadPersistedMembershipCancellationSettings` casts `prisma as unknown as { membershipCancellationSetting?: ... }` and catches every error silently with `catch {}`. This bypasses Prisma's generated types and hides genuine database errors as "no settings found", which can mask migration or schema drift.
- **Suggested fix**: If the model is in the Prisma schema (it is, per migrations), use the typed delegate directly. Reserve the runtime existence check (and the catch) for tests that mock a partial client, or replace with explicit `try { … } catch (err) { logger.warn(...) ; return null; }`.
- **Commit**: 22bad90

### [MEDIUM] Dead-looking `creditNoteUrl = null` constant
- **Location**: `src/lib/membership-cancellation-xero.ts:389, 396, 434, 442, 459`
- **Issue**: `const creditNoteUrl = null;` is then passed verbatim as `xeroObjectUrl: creditNoteUrl` five times. Either the URL needs to be computed (e.g. via `buildXeroCreditNoteUrl(createdNote.creditNoteID)` to match the invoice path at line 233) or the assignments should pass `null` directly without the named placeholder, which currently reads like a forgotten TODO.
- **Suggested fix**: Compute the credit-note URL or remove the named placeholder and pass `null`. If left intentionally null, add a one-line comment explaining why credit notes have no deep link.
- **Commit**: 8c0a9ec

### [MEDIUM] `MemberDeleteEligibility` builder is over 250 lines of repeated `pushCountBlocker` calls
- **Location**: `src/lib/member-lifecycle-actions.ts:170-430`
- **Issue**: 22 sequential count queries followed by 22 push-if-positive calls. The pattern is rigid enough to drive from a table.
- **Suggested fix**: Define `const blockerSpecs: Array<{ code, label, query: (db) => Promise<number> }> = [...]`, then `Promise.all(blockerSpecs.map(s => s.query(db)))` and a single loop to push. Easier to add new blockers and harder to misalign a label with the wrong count (which the current code is one accidental reorder away from).
- **Commit**: e3ca9c5

### [LOW] Redundant comments restate the next line
- **Location**: `src/app/api/bookings/[id]/modify/route.ts:187, 273, 324, 363, 379, 566, 616, 622, 643, 656, 673, 710, 794, 812, 910, 957, 1011`
- **Issue**: Comments like `// Determine new dates`, `// Calculate new total price`, `// Audit log`, `// Email notification` repeat what the immediately following code says. They are pure section labels in a function too long to have sections.
- **Suggested fix**: Resolve via the [HIGH] split above; the section labels become helper function names instead.
- **Commit**: 7932719

### [LOW] Single-use type alias adds indirection
- **Location**: `src/lib/payment-recovery.ts:33`
- **Issue**: `type PaymentRecoveryOperationRecord = PaymentRecoveryOperation;` is a verbatim alias used in nine signatures. Readers must jump to line 33 to confirm it is not a richer payload.
- **Suggested fix**: Replace usages with the Prisma type directly, or extend the alias with whatever non-Prisma fields motivated it.
- **Commit**: 228f24e

### [LOW] Magic Stripe back-off array could be named
- **Location**: `src/lib/payment-recovery.ts:25`
- **Issue**: `const RETRY_BACKOFF_MINUTES = [5, 15, 60, 240, 720];` reads fine, but the relationship to `MAX_PAYMENT_RECOVERY_ATTEMPTS = 5` (same length, not coincidence) is implicit. Off-by-one between the two constants would silently clamp to the last value.
- **Suggested fix**: Add a one-line comment, or `assert(RETRY_BACKOFF_MINUTES.length === MAX_PAYMENT_RECOVERY_ATTEMPTS)` at module init.
- **Commit**: 228f24e

### [LOW] Self-explanatory section dividers
- **Location**: `src/app/api/bookings/[id]/modify/route.ts:417, 616, 622, 643, 656, 673, 710, 794, 812, 910`
- **Issue**: Heavy `// --- Foo ---` dividers are visual noise once the function is split.
- **Suggested fix**: Remove with the split refactor.
- **Commit**: 7932719

### [LOW] Inconsistent "name" string building
- **Location**: `src/app/api/bookings/[id]/change-requests/route.ts:336`, `src/lib/payment-recovery.ts:193`, `src/lib/member-lifecycle-actions.ts:108-110`, `src/lib/membership-cancellation-admin.ts:147-149`
- **Issue**: Some sites use `\`${firstName} ${lastName}\``, others use `[firstName, lastName].filter(Boolean).join(" ").trim()`. The latter handles a missing surname; the former does not.
- **Suggested fix**: Adopt the helper version (already present in two modules) and reuse it via the proposed shared serialization module above.
- **Commit**: 6d9ba04 / 228f24e

### [LOW] `BookingEditMode` exported but only one consumer outside the policy file
- **Location**: `src/lib/booking-edit-policy.ts:24`
- **Issue**: Exported union type but the only external usage is the `editPolicy.mode === "in-progress"` string literal comparison in `modify/route.ts:197` and `change-requests/route.ts:79`. The type alias never appears on a consumer signature.
- **Suggested fix**: Either annotate consumers with `BookingEditMode` or drop the export and inline the union.
- **Commit**: 7932719

### [LOW] `ApiError` class redefined locally instead of using shared helper
- **Location**: `src/app/api/bookings/[id]/modify/route.ts:89-96`
- **Issue**: A bare `ApiError extends Error` with `status` is declared inline; similar shapes are likely already in use (e.g. `MembershipCancellationAdminError`, `MemberLifecycleActionError`, `BookingGuestValidationError`).
- **Suggested fix**: Either reuse a shared `HttpError` if one exists, or at minimum lift this declaration alongside the other domain errors so the pattern is uniform.
- **Commit**: 7932719

## Notes on overall code style
- Naming and serialization patterns are consistent within each new module but drift across modules (three implementations of `cleanText`, two `memberName` shapes, two name-string-concat idioms). A small shared "serialization" module would tighten this.
- New Prisma-touching code reliably uses `satisfies Prisma.XxxInclude` and parameter destructuring objects with named flags. Good. The exception is `membership-cancellation-requests.ts`, which inlines the same include block four times.
- Error handling is uniformly via domain-specific `extends Error` subclasses with a `statusCode`. Route handlers translate these to `NextResponse.json`. The pattern works; only the inline `ApiError` in `modify/route.ts` deviates.
- New library code is well-typed and largely avoids `any`. The lone `as unknown as { ... }` cast in `membership-cancellation-settings.ts` is the only escape hatch noted.
- Most files are well-sized (100-900 lines) and single-purpose. The outliers are `modify/route.ts` (1069) which is genuinely too long, and `member-lifecycle-actions.ts` (1001) which is long but logically partitioned by request/review per action - the eligibility builder is the only section that warrants compression.
