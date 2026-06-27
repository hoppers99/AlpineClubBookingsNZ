# Finance Dashboard

The finance dashboard is the native AlpineClubBookingsNZ reporting workspace under
`/finance`. It uses AlpineClubBookingsNZ credentials, explicit finance access levels,
first-party booking data, and the single operational Xero connection.

## Access Model

- `Member.financeAccessLevel = NONE` cannot access finance pages or finance
  APIs.
- `VIEWER` can read the finance workspace and reports.
- `MANAGER` can trigger a manual finance sync and manages the operational Xero
  connection from `/admin/xero`.
- `ADMIN` alone does not grant finance access.

## Xero Connection

Finance reporting uses the single operational Xero connection that bookings,
payments, and subscriptions already use. There are no finance-specific Xero env
vars, token storage, callback routes, or usage metering. The connection is
managed from `/admin/xero`.

The finance sync needs the `accounting.reports.read` scope. After deploy, Xero
must be reconnected once from `/admin/xero` so existing tokens gain this scope.
See `finance-xero-config-contract.md`.

Normal finance report navigation reads stored snapshots or first-party
AlpineClubBookingsNZ booking/payment data. It should not make live Xero calls on page
render.

## Data Model

- Xero-derived accounting datasets are persisted as `FinanceSnapshot` rows.
- Daily sync is handled by the finance sync cron and durable service layer.
- Booking, occupancy, guest-night, and pricing-sensitivity reports use
  AlpineClubBookingsNZ booking/payment data directly.
- Finance API and page contracts are described in this directory so report
  definitions stay explicit.

## Contract Index

- [data-contracts.md](data-contracts.md)
- [finance-xero-config-contract.md](finance-xero-config-contract.md)
- [finance-revenue-reconciliation-contract.md](finance-revenue-reconciliation-contract.md)
- [finance-snapshot-storage-contract.md](finance-snapshot-storage-contract.md)
- [finance-sync-service-contract.md](finance-sync-service-contract.md)
- [finance-sync-cron-contract.md](finance-sync-cron-contract.md)
- [finance-sync-diagnostics-contract.md](finance-sync-diagnostics-contract.md)
- [finance-manual-sync-contract.md](finance-manual-sync-contract.md)
- [finance-booking-metrics-contract.md](finance-booking-metrics-contract.md)
- [finance-landing-page-contract.md](finance-landing-page-contract.md)
- [finance-bookings-report-contract.md](finance-bookings-report-contract.md)
- [finance-revenue-report-contract.md](finance-revenue-report-contract.md)
- [finance-costs-report-contract.md](finance-costs-report-contract.md)
- [finance-pricing-sensitivity-report-contract.md](finance-pricing-sensitivity-report-contract.md)
- [finance-working-capital-report-contract.md](finance-working-capital-report-contract.md)
- [finance-cash-report-contract.md](finance-cash-report-contract.md)
- [finance-balance-sheet-report-contract.md](finance-balance-sheet-report-contract.md)
- [test-plan.md](test-plan.md)

## ADRs

- [ADR-001: Native finance dashboard in AlpineClubBookingsNZ](decisions/ADR-001-native-finance-dashboard-in-tacbookings.md)
- [ADR-002: Finance access control](decisions/ADR-002-finance-access-control.md)
- [ADR-003: Separate finance Xero boundary (superseded by ADR-005)](decisions/ADR-003-separate-finance-xero-boundary.md)
- [ADR-004: PostgreSQL snapshots over CSV](decisions/ADR-004-postgres-snapshots-over-csv.md)
- [ADR-005: Single operational Xero connection](decisions/ADR-005-single-operational-xero-connection.md)

## Maintenance Rules

- Update `data-contracts.md` before changing metric definitions.
- Do not grant finance access by broadening `ADMIN`; update ADR-002 first if
  the access model changes.
- The finance sync uses the single operational Xero connection; update ADR-005
  first if that changes.
- Keep report pages backed by snapshots or first-party AlpineClubBookingsNZ data unless a
  contract explicitly allows a live integration call.
