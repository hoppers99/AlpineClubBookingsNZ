# Maintenance

This document describes the public maintenance baseline for AlpineClubBookingsNZ.

## Required Gates

Run lightweight local gates before opening or merging application changes:

```bash
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma generate
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx tsc --noEmit
npm test
npm run quality:report
git diff --check
```

CI also runs independent static and container checks:

- `npm audit --audit-level=high --package-lock-only` on pull requests
- Semgrep with Next.js, TypeScript, JavaScript, and React rules
- gitleaks full-history and pull-request diff scans
- TypeScript, test, and Docker image build validation
- Trivy critical vulnerability gate with high-severity warnings

## Dependency Policy

- Keep `package-lock.json` committed.
- Prefer small dependency update PRs with explicit validation results.
- Keep security overrides documented in `package.json` and remove them when the
  upstream dependency graph no longer needs them.
- Use test or demo credentials for Stripe, Xero, SES, and Sentry in local and
  CI environments.

## Maintainability Budgets

The repo has a handful of oversized files and route surfaces. Future
refactors should keep new code inside soft budgets so reviewers can spot
regressions early. Treat these as review prompts, not hard CI gates:

- Route handlers (`src/app/.../route.ts`) should generally stay under
  roughly 250 LOC.
- App Router page shells (`src/app/.../page.tsx`) should generally stay
  under roughly 500 LOC.
- New domain modules (`src/lib/...`, `src/components/...`) should
  generally stay under roughly 700 LOC.
- No new production `any`, type suppression (`@ts-ignore`,
  `@ts-expect-error`, `@ts-nocheck`), or `eslint-disable` without a
  short inline comment explaining the local justification.

When a file is already over budget, prefer extracting cohesive helpers
into a focused module rather than adding more to the existing surface.

### Quality report

Run the local maintainability report before opening broad refactor PRs, after
splitting a large surface, and when reviewing a PR that adds substantial
production code:

```bash
npm run quality:report
```

The script scans tracked files via `git ls-files` and prints a markdown
summary of:

- largest production files
- largest route handlers and App Router pages
- newly oversized files outside the accepted-hotspot allow-list
- largest test files
- production `any` / type-suppression hotspots
- production `eslint-disable` hotspots
- test `as any` totals

It uses only existing repo tooling, runs without external service
credentials or network access, and is advisory: it warns and informs rather
than failing the build. The `Over budget` column is a soft review prompt:
`yes` means the file exceeds the route-handler, page-shell, or new-domain-module
budget. The `Newly oversized files` section is stricter: it lists oversized
production files that are not in the accepted hotspot allow-list below, so
reviewers can spot regressions without making the report a CI gate.

### Known remaining hotspots

These files are intentionally still over budget in the current post-refactor
baseline. Do not expand this list casually; new entries should be treated as
review findings unless there is an explicit follow-up plan.

| File | Current LOC | Disposition |
| --- | ---: | --- |
| `src/lib/xero-inbound-reconciliation.ts` | 2926 | Queued for future split when reconciliation classification, repair, or reporting changes next land. |
| `src/lib/xero-booking-repair.ts` | 2682 | Accepted as-is for now: operator repair tool, documented separately, not normal request-path code. |
| `src/lib/xero-operation-outbox.ts` | 2028 | Queued for future split when queue dispatch, release, or retry policy changes next land. |
| `src/lib/email-templates.ts` | 2006 | Accepted as-is for now: central template catalogue; split only with a template-registry change. |
| `src/lib/email.ts` | 1936 | Queued for future split when transport, registry, or recipient-policy work next lands. |
| `src/lib/xero-hardening.ts` | 1606 | Accepted as-is for now: central Xero hardening policy and diagnostics boundary. |
| `src/lib/finance-sync-xero-datasets.ts` | 1573 | Queued for future split by finance snapshot family when finance dataset work resumes. |
| `src/app/(admin)/admin/members/[id]/page.tsx` | 1747 | Queued for future route-shell thinning as member-detail sections continue to move local state out. |
| `src/app/(admin)/admin/family-groups/page.tsx` | 1312 | Queued for future route-shell thinning when family-group workflows are next touched. |

## Operational Repair Tools

`scripts/xero-booking-repair.ts` is a targeted booking/Xero reconciliation
helper. Keep it out of normal setup and deployment flows. Use it only when an
operator needs to inspect or repair known booking-payment/Xero mismatches after
reviewing the affected bookings.

Always start with a dry run:

```bash
npx tsx scripts/xero-booking-repair.ts --dry-run
npx tsx scripts/xero-booking-repair.ts --booking <bookingId> --dry-run
npx tsx scripts/xero-booking-repair.ts --from <YYYY-MM-DD> --to <YYYY-MM-DD> --dry-run
```

Only use `--apply` after the dry-run report has been reviewed. Do not run it
with live Xero, Stripe, SES, Sentry, or production database credentials during
exploratory work; use a staging database and Xero demo tenant where possible.

## Public Release Checklist

Before changing repository visibility to public:

1. Confirm `main` has a green local validation run and a green GitHub Actions
   run.
2. Run a full-history secret scan.
3. Confirm `.env`, `.env.local`, production logs, generated reports, `.next`,
   and database dumps are not tracked.
4. Enable Dependabot, dependency graph, secret scanning, and branch protection
   options available to the repository.
5. Create a release tag for the public reference snapshot.

## GitHub Actions Availability

If Actions jobs fail before starting, check repository or account billing and
spending limits before treating the failures as code failures.
