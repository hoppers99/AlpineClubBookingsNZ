# Issue #914 Post-Fix Hardening And Feature Harmony Review

Date: 2026-06-29  
Review branch: `codex/issue-914-post-fix-harmony-review`  
Review baseline: current `origin/main` at `ccbd7ea0`  
Mode: review-only, with follow-up issue creation for new defects

## Recommendation

No release-blocking finding was identified in the #908-#913 post-fix scope.
Current `origin/main` is merge/deploy ready for the reviewed areas, subject to
normal CI and the owner review gate for this review PR.

One low-severity documentation drift finding was found on public main. It is
tracked separately as #933 and should not block deployment.

## Scope And Safety

- Dependent issues #908, #909, #910, #911, #912, and #913 were verified closed
  before this review branch was updated to current `origin/main`.
- The review inspected current public main behavior, not the older `5348653a`
  review baseline.
- No production credentials, production databases, live provider calls, dev
  servers, browser automation, live endpoint scans, or production backups were
  used.
- Branch-only changes are limited to this review report. Findings below are
  separated as public-main findings or branch-only status.

## Findings

| ID | Severity | Scope | Status |
| --- | --- | --- | --- |
| F-01 | Low | Public main | Follow-up issue #933 created |

### F-01: PageContent Image Picker Documentation Is Stale

Severity: Low  
Affected files: `CONFIGURATION.md`, PageContent/image documentation only  
Validation status: Static review. Runtime code paths and tests indicate this is
documentation/operator workflow drift, not a security bypass.

Evidence:

- `CONFIGURATION.md:127` through `CONFIGURATION.md:129` still says the editor's
  image picker lists only images deployed under `public/branding/` and that
  there is no admin UI upload path.
- `src/components/admin/page-content-panel.tsx:999` through
  `src/components/admin/page-content-panel.tsx:1003` tells admins the picker can
  use uploaded images, deployed branding images, or a new image upload.
- `src/app/api/admin/image-library/route.ts:85` through
  `src/app/api/admin/image-library/route.ts:184` implements database-backed
  image uploads served from `/api/images/[id]`.
- `src/app/api/admin/image-manager/upload/route.ts:75` through
  `src/app/api/admin/image-manager/upload/route.ts:100` rejects unsupported
  MIME types and extensions for filesystem image-manager uploads.
- `src/app/api/images/[id]/route.ts:32` through
  `src/app/api/images/[id]/route.ts:40` serves database-backed images with
  `nosniff` and a restrictive image-response CSP.

Suggested fix:

Update `CONFIGURATION.md` to describe the current image sources accurately:
database-backed image-library uploads, deployed branding images, filesystem
image-manager uploads under the shared `public/images` volume, and the SVG
distinction between CSP-protected database image serving and static
image-manager SVG rejection.

Tracking:

- Follow-up issue: #933, "Align PageContent image picker documentation with
  image library uploads".

## Area Review Notes

### Member CSV Import

Result: No new finding.

The server-side import path matches the shared-email identity and durability
contracts:

- Existing members are loaded by normalized email and used to build duplicate
  identity and login-claim state in
  `src/app/api/admin/members/import/route.ts:259` through
  `src/app/api/admin/members/import/route.ts:292`.
- Duplicate identity is email plus first and last name; same identity rows are
  skipped before commit in
  `src/app/api/admin/members/import/route.ts:330` through
  `src/app/api/admin/members/import/route.ts:355`.
- `canLogin` is claimed once per email in
  `src/app/api/admin/members/import/route.ts:421` through
  `src/app/api/admin/members/import/route.ts:431`, and row notes explain why
  later shared-email rows cannot log in.
- Member creation and audit writes remain inside one transaction in
  `src/app/api/admin/members/import/route.ts:481` through
  `src/app/api/admin/members/import/route.ts:563`.
- Setup tokens and invite emails are post-commit best effort and run only for
  imported rows that can log in in
  `src/app/api/admin/members/import/route.ts:582` through
  `src/app/api/admin/members/import/route.ts:603`.
- UI result messaging surfaces zero-created no-ops, skipped rows, login-enabled
  count, non-login count, and row notes in
  `src/app/(admin)/admin/members/_components/member-import-dialog.tsx:679`
  through
  `src/app/(admin)/admin/members/_components/member-import-dialog.tsx:779`.
- `CONFIGURATION.md:257` through `CONFIGURATION.md:270` documents the duplicate
  identity and shared-email login contract.

Focused coverage reviewed:

- `src/lib/__tests__/phase3-admin-members.test.ts:798` through
  `src/lib/__tests__/phase3-admin-members.test.ts:910`.
- `src/lib/__tests__/phase3-admin-members.test.ts:957` through
  `src/lib/__tests__/phase3-admin-members.test.ts:1008`.
- `src/lib/__tests__/phase3-admin-members.test.ts:1177` through
  `src/lib/__tests__/phase3-admin-members.test.ts:1327`.
- `src/lib/__tests__/member-import-dialog.test.tsx:125` through
  `src/lib/__tests__/member-import-dialog.test.tsx:200`.

### Xero Setup And Scopes

Result: No new finding.

- Operational OAuth scopes are centralized in
  `src/lib/xero-config.ts:6` through `src/lib/xero-config.ts:29`; the obsolete
  `accounting.reports.read` scope is not requested.
- The admin status endpoint reports connection state only from stored token
  presence in `src/app/api/admin/xero/status/route.ts:10` through
  `src/app/api/admin/xero/status/route.ts:18`, while the UI copy avoids saying
  finance report scopes are ready just because Xero is connected in
  `src/app/(admin)/admin/xero/_components/connection-status-panel.tsx:30`
  through
  `src/app/(admin)/admin/xero/_components/connection-status-panel.tsx:33`.
- Finance report sync rewrites `insufficient_scope` failures to exact
  granular-scope reconnect guidance in
  `src/lib/finance-sync-xero-datasets.ts:417` through
  `src/lib/finance-sync-xero-datasets.ts:462`.
- OAuth state is random, HttpOnly, scoped to `/api/admin/xero`, and checked with
  timing-safe comparison in `src/lib/xero-oauth-state.ts:31` through
  `src/lib/xero-oauth-state.ts:64`.
- Callback logging records path and boolean metadata only, and callback errors
  are reduced to safe reconnect guidance in
  `src/app/api/admin/xero/callback/route.ts:11` through
  `src/app/api/admin/xero/callback/route.ts:26` and
  `src/app/api/admin/xero/callback/route.ts:57` through
  `src/app/api/admin/xero/callback/route.ts:79`.
- `CONFIGURATION.md:356` through `CONFIGURATION.md:371` documents the granular
  finance report scopes and reconnect workflow.

Focused coverage reviewed:

- `src/lib/__tests__/xero-config.test.ts:30` through
  `src/lib/__tests__/xero-config.test.ts:61`.
- `src/lib/__tests__/xero-connection-status-panel.test.tsx:8` through
  `src/lib/__tests__/xero-connection-status-panel.test.tsx:30`.
- `src/lib/__tests__/xero-oauth-routes.test.ts:57` through
  `src/lib/__tests__/xero-oauth-routes.test.ts:165`.
- `src/lib/__tests__/finance-sync-datasets.test.ts:1321` through
  `src/lib/__tests__/finance-sync-datasets.test.ts:1363`.

### Admin Navigation

Result: No new finding.

- Family Groups is in the queue-driven Needs Attention section in
  `src/components/admin-sidebar.tsx:93` through
  `src/components/admin-sidebar.tsx:121`.
- Pending family requests are fetched from
  `/api/admin/family-groups/requests` and counted in
  `src/components/admin-sidebar.tsx:313` through
  `src/components/admin-sidebar.tsx:330`.
- Badges make Family Groups visible while pending requests exist in
  `src/components/admin-sidebar.tsx:545` through
  `src/components/admin-sidebar.tsx:567`.
- Section collapse state is persisted with `aria-expanded` on toggle buttons in
  `src/components/admin-sidebar.tsx:509` through
  `src/components/admin-sidebar.tsx:543` and
  `src/components/admin-sidebar.tsx:597` through
  `src/components/admin-sidebar.tsx:619`.
- Desktop and mobile sidebars use independent scroll containers in
  `src/components/admin-sidebar.tsx:673` through
  `src/components/admin-sidebar.tsx:707`.
- Feature/module visibility still flows through
  `src/config/feature-routes.ts:9` through `src/config/feature-routes.ts:166`
  and `src/proxy.ts:82` through `src/proxy.ts:125`.

Focused coverage reviewed:

- `src/lib/__tests__/admin-sidebar.test.tsx:80` through
  `src/lib/__tests__/admin-sidebar.test.tsx:145`.
- `src/lib/__tests__/feature-navigation.test.ts:74` through
  `src/lib/__tests__/feature-navigation.test.ts:135`.

### Photo And PageContent Embeds

Result: No new finding beyond F-01 documentation drift.

- Photo embed tokens now require double braces; single-brace syntax is only
  accepted for non-photo legacy tokens in
  `src/lib/page-content-embeds.ts:34` through
  `src/lib/page-content-embeds.ts:41`.
- Inline images are extracted only when an inline photo token is present in
  `src/lib/page-content-embeds.ts:147` through
  `src/lib/page-content-embeds.ts:160`.
- Directory parameters are normalized and then contained by
  `resolveInImagesRoot` in `src/lib/page-content-embeds.ts:68` through
  `src/lib/page-content-embeds.ts:84` and
  `src/lib/image-storage.ts:41` through `src/lib/image-storage.ts:53`.
- Public PageContent HTML is sanitized on read before it reaches
  `dangerouslySetInnerHTML` in `src/lib/page-content-html.ts:221` through
  `src/lib/page-content-html.ts:239`.
- Code-backed public pages render embedded parts through `buildEmbeddedBody`:
  `/join` in `src/app/(website)/join/page.tsx:20` through
  `src/app/(website)/join/page.tsx:52`, `/join/apply` in
  `src/app/(website)/join/apply/page.tsx:23` through
  `src/app/(website)/join/apply/page.tsx:56`, and `/contact` in
  `src/app/(website)/contact/page.tsx:22` through
  `src/app/(website)/contact/page.tsx:55`.
- The shared `EmbeddedPageContentParts` renderer maps photo gallery and
  slideshow parts to `PhotoGalleryToken` in
  `src/components/website/embedded-page-content-parts.tsx:71` through
  `src/components/website/embedded-page-content-parts.tsx:90`.
- PhotoSwipe slideshow auto-open is tied to the slideshow variant and is
  cancelled on unmount in
  `src/components/website/photo-gallery-token.tsx:129` through
  `src/components/website/photo-gallery-token.tsx:146`.

Focused coverage reviewed:

- `src/lib/__tests__/page-content-embeds.test.ts:22` through
  `src/lib/__tests__/page-content-embeds.test.ts:93`.
- `src/lib/__tests__/photo-gallery-token.test.tsx:55` through
  `src/lib/__tests__/photo-gallery-token.test.tsx:129`.
- `src/lib/__tests__/code-backed-page-content-tokens.test.tsx:87` through
  `src/lib/__tests__/code-backed-page-content-tokens.test.tsx:240`.
- `src/lib/__tests__/page-content-html.test.ts:26` through
  `src/lib/__tests__/page-content-html.test.ts:97`.
- `src/lib/__tests__/image-storage.test.ts:13` through
  `src/lib/__tests__/image-storage.test.ts:56`.

## Validation

Completed on this branch:

- `git diff --check` passed.
- `npm run lint` passed.
- `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate`
  passed.
- `npx tsc --noEmit` passed after regenerating the local Prisma client with
  `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma generate`.
  The initial TypeScript run failed because the local generated client was stale
  after the newer membership-type schema merge on `origin/main`.
- Focused tests passed:
  `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npm test -- src/lib/__tests__/phase3-admin-members.test.ts src/lib/__tests__/member-csv-import.test.ts src/lib/__tests__/member-import-dialog.test.tsx src/lib/__tests__/xero-config.test.ts src/lib/__tests__/xero-oauth-routes.test.ts src/lib/__tests__/xero-connection-status-panel.test.tsx src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/admin-sidebar.test.tsx src/lib/__tests__/feature-navigation.test.ts src/lib/__tests__/page-content-embeds.test.ts src/lib/__tests__/photo-gallery-token.test.tsx src/lib/__tests__/code-backed-page-content-tokens.test.tsx src/lib/__tests__/page-content-html.test.ts src/lib/__tests__/image-storage.test.ts src/lib/__tests__/public-images-route.test.ts src/lib/__tests__/api-route-boundaries.test.ts`
  passed with 16 test files and 164 tests.
- Broad tests passed:
  `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npm test`
  passed with 367 test files passed, 1 skipped; 3804 tests passed, 1 skipped.

## Residual Risks

- This was a static/code review plus automated validation. No live Xero, Stripe,
  SES, production database, browser automation, or live-site smoke test was run.
- The review PR is human-review gated by #914. It should not be merged
  autonomously.
- Follow-up #933 is documentation-only and non-blocking, but should be completed
  to keep operator instructions aligned with the current PageContent image
  workflow.
