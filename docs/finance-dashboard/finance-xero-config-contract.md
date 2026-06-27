# Finance Xero Connection Contract

This document defines how the finance dashboard connects to Xero.

## Single Operational Connection

Finance reporting uses the single operational Xero connection that bookings, payments, and subscriptions already use. There is no separate finance Xero OAuth app, connection, or persistence boundary.

- The finance sync authenticates with `getAuthenticatedXeroClient` from `src/lib/xero-api-client.ts`, bound for finance use through `createFinanceXeroSyncConnection` in `src/lib/finance-sync-service.ts`.
- Operational tokens persist through the existing `XeroToken` table. There is no `FinanceXeroToken` table.
- The Xero connection is managed from `/admin/xero`. There is no finance-specific connect, callback, status, or disconnect flow.

## Config Changes

The only finance-relevant config change is an added OAuth scope.

- `accounting.reports.read` was added to `OPERATIONAL_XERO_OAUTH_SCOPES` in `src/lib/xero-config.ts`. This scope is required by the profit-and-loss, balance-sheet, and bank-summary report fetchers.
- After deploy, Xero must be reconnected once from `/admin/xero` so existing tokens gain this scope, and the Xero developer-portal app must allow it.
- Until reconnected, the report datasets return a clear "reconnect Xero" message (see `withFinanceReportScopeError` in `src/lib/finance-sync-xero-datasets.ts`).
- The chart-of-accounts dataset only needs `accounting.settings.read`, which the operational connection already had, so it works without re-consent.

## No Finance-specific Config

There are no finance-specific:

- environment variables (no `FINANCE_XERO_*` env vars)
- OAuth client, redirect URIs, or callback routes
- token encryption keys or key rotation
- token tables or API-usage metering tables

Operational Xero code keeps using the existing `XERO_*` env names and the operational `XeroToken` store.
