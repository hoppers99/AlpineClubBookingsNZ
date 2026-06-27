# ADR-003: Keep a Separate Finance Xero OAuth Boundary

## Status

Superseded by ADR-005 (2026-06-26).

The separate finance Xero OAuth client, token store, usage metering, and
`/api/finance/xero/*` routes described below were removed. The finance dashboard
now runs off the single operational Xero connection. This ADR is retained for
historical context; see ADR-005 for the current decision.

## Context

The existing AlpineClubBookingsNZ Xero integration serves operational workflows such as:

- member contacts and imports (`src/lib/xero-contacts.ts`, `src/lib/xero-member-import.ts`)
- subscriptions (`src/lib/xero-membership-sync.ts`)
- booking invoices (`src/lib/xero-booking-invoices.ts`)
- refund credit notes (`src/lib/xero-credit-notes.ts`)
- operational reconciliation (`src/lib/xero-inbound-reconciliation.ts`)

The finance dashboard has its own API-usage concerns and should not consume the same OAuth app, token pool, or usage budget.

## Decision

Implement finance reporting against a separate Xero OAuth client/app and separate persistence boundary inside the AlpineClubBookingsNZ codebase.

This means separate:

- environment variables
- token storage
- usage metering
- sync run history

It does not require a separate repository or separate production application.

## Consequences

### Positive

- preserves independent API budget and OAuth lifecycle
- avoids operational Xero workflows being impacted by finance reporting usage
- still allows one deployment and one user login surface

### Negative

- duplicates some Xero integration scaffolding
- requires care to keep operational and finance boundaries from being mixed in code
