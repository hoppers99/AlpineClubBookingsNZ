# Security Policy

## Supported Version

Security fixes are accepted for the current `main` branch. Public releases are
reference snapshots of the application and should be updated before production
use.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting or a GitHub security advisory when
available. If private reporting is unavailable, contact the repository
maintainers through a private channel first and avoid including secrets,
personal data, or exploit details in public comments.

Reports should include:

- affected route, API endpoint, job, or integration
- expected and observed behaviour
- reproduction steps using non-production data
- impact assessment and any relevant logs with secrets redacted

## Security Baseline

This project uses:

- Next.js App Router with server-side route handlers
- Auth.js / NextAuth credentials sessions
- Prisma and PostgreSQL
- Stripe PaymentIntents, SetupIntents, and webhooks
- Xero OAuth and webhook integrations
- AWS SES email and SNS feedback ingestion
- gitleaks, Semgrep, npm audit, Trivy and CodeQL in CI

## Which CI security checks block a merge

Four of them are required protected-branch checks on `main`, so a finding stops
the merge rather than only turning a job red:

- **`Secret scan (gitleaks)`** — gitleaks over the pull request's own commits and
  over the full repository history, in one pinned container. Suppressions are
  content-scoped allowlists in `.gitleaks.toml` and per-finding fingerprints in
  `.gitleaksignore`; both files explain every entry.
- **`Static analysis gate`** — Semgrep, running four registry packs plus this
  repository's own rules in `.semgrep/rules/`. The same job first runs each
  custom rule against its must-fail/must-pass fixtures in `.semgrep/tests/`.
- **`Image security gate (Trivy CRITICAL)`** — a CRITICAL vulnerability in the
  built container image. HIGH findings are reported in the same job but are
  advisory and cannot block.
- **`verify`** — carries `npm audit --audit-level=high` alongside lint, types and
  tests.

CodeQL runs as **advisory** analysis through GitHub code scanning default setup
(`actions`, `javascript`, `javascript-typescript`, `typescript`). Its findings
are investigated but never block a merge, and it does not report on pull requests
from forks. `AGENTS.md` → "Completion and Merge" holds the authoritative list of
every required check.

To reproduce the secret scan locally, with the same pinned image CI uses:

```bash
docker run --rm -v "$PWD:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.28.0 \
  git /repo --log-opts=--all --exit-code=1 --redact
```

Add `--report-format=json --report-path=/repo/leaks.json` to read the
`Fingerprint` field for a `.gitleaksignore` entry.

Never test against a live production deployment without written approval from
the deployment owner. Use local or staging environments with test Stripe keys,
Xero demo credentials, and synthetic data.
