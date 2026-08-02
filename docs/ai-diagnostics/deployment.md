# AI Diagnostics deployment and operator guide

How a deployment turns AI Diagnostics on, and what it must provision first. AI
Diagnostics is an **optional, admin-only, default-off** module (epic
[#2369](README.md)).

This guide covers what has landed: the module flag, the dedicated Anthropic
credential, the monthly budget and limits (AID-2, #2371), and the dedicated
SELECT-only database role (AID-5, #2374). Provider disclosure, zero-retention
posture, and the private knowledge overlay are documented by AID-8 (#2379) when it
lands.

Extends [`DEPLOYMENT.md`](../../DEPLOYMENT.md) and
[`CONFIGURATION.md`](../../CONFIGURATION.md).

## Configuration is deployment-local

Every Diagnostics setting is **deployment-owned** and stays out of config-transfer
bundles ([ADR-006](decisions/ADR-006-deployment-provider-disclosure-private-overlay-config-non-travel.md)).
Two deployments of this codebase can run Diagnostics with different keys, budgets,
and database roles, and nothing about one travels to the other.

## Setup order

1. **Provision the SELECT-only database role** (below) and set
   `AI_DIAGNOSTICS_DATABASE_URL`.
2. **Store the dedicated Anthropic API key** in **Admin → Integrations** (encrypted
   `IntegrationCredential`, provider `anthropic-diagnostics`). It is deliberately a
   separate key from the member-facing Page help assistant's, so Diagnostics spend
   can be billed and capped on its own workspace, and a Page help key can never
   silently authorise Diagnostics spend.
3. **Set a positive monthly budget** in integer cents.
4. **Enable the `aiDiagnostics` module.**

Check progress at any time with `GET /api/admin/ai-diagnostics/readiness`
(support-area admin permission; reachable **while the module is off**, on purpose,
so setup can be completed before the paid product is switched on). It spends
nothing and returns no secret value.

Readiness is **fail-closed**: `ready` is true only when the module is on, the
dedicated key is stored and decryptable, the monthly budget is positive, and the
SELECT-only role is **verified** least-privilege. Any fault while resolving those
returns `ready: false` with a `resolve_error` blocker rather than throwing.

## The dedicated SELECT-only database role

### Why it is mandatory

The application's own database role, as provisioned in the Compose stack, is a
PostgreSQL **superuser**. Diagnostics runs data-retrieval tools; if those ran on
`DATABASE_URL`, a single flaw would run with superuser rights and could read the
encrypted credential store, write, or escalate.
[ADR-007](decisions/ADR-007-least-privilege-select-only-database-credential.md)
therefore requires a **separate, non-superuser, SELECT-only** role, and the
application **refuses to run any diagnostics read** without one. There is no
fallback to `DATABASE_URL`.

The refusal is not a configuration check that trusts the URL. On first use the
application asks the **server** what privileges the connected role actually holds —
superuser, `CREATEDB`, `CREATEROLE`, `REPLICATION`, `BYPASSRLS`, `TEMPORARY` or
`CREATE` on the database, `CREATE` on schema `public`, `EXECUTE` on
`pg_read_file`, and membership in any privilege-escalating predefined role — and
refuses every tool call unless all of them are absent. A role that was hand-edited
back towards write access is caught on the next tool call, not at the next code
review.

### Provisioning

```bash
AI_DIAGNOSTICS_DB_PASSWORD='<a long random secret>' npm run diagnostics:provision-role
```

Preview the exact statements without connecting (the password literal is replaced
with a placeholder, so nothing secret is printed):

```bash
npm run diagnostics:provision-role -- --dry-run
```

The script needs a connection that may create roles: the application's own
`DATABASE_URL` in the stock Compose stack, or `AI_DIAGNOSTICS_PROVISION_DATABASE_URL`
for a deployment that keeps a separate DBA credential.

| Variable | Required | Meaning |
| --- | --- | --- |
| `AI_DIAGNOSTICS_DB_PASSWORD` | yes (not for `--dry-run`) | The new role's password. Minimum 20 characters. Never printed or logged. |
| `AI_DIAGNOSTICS_PROVISION_DATABASE_URL` | no | Connection that may create roles. Defaults to `DATABASE_URL`. |
| `AI_DIAGNOSTICS_DB_ROLE` | no | Role name. Defaults to `ai_diagnostics_ro`. Refused if it equals the provisioning role. |
| `AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES` | no | Comma-separated roles that must keep `TEMPORARY` on the database (see below). Defaults to the provisioning role. |

Then set the connection string in the deployment environment (the Compose `.env`):

```
AI_DIAGNOSTICS_DATABASE_URL=postgresql://ai_diagnostics_ro:<password>@postgres:5432/tacbookings?connection_limit=3
```

Compose passes it through to the app containers. Leave it empty and Diagnostics
stays not-ready; there is no unsafe default.

### What provisioning does

It runs one transaction, so a failure part-way leaves no partially privileged role
behind. The statements are **declarative, not additive**: every table, sequence, and
routine privilege is revoked from the role before the declared allowlist is granted
back. The allowlist lives in `src/lib/diagnostics/tools/provision-role.ts`, in
public code, so "which tables can Diagnostics read" is answered by reading one file.

- Creates the role if absent, then pins its attributes whether it was just created
  or already existed with drifted attributes: `NOSUPERUSER`, `NOCREATEDB`,
  `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, `NOBYPASSRLS`, a `CONNECTION LIMIT`,
  and the password.
- Sets server-side defaults on the role itself — `default_transaction_read_only`,
  `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, and
  `search_path` — so the restrictions hold even for a `psql` session an operator
  opens with this credential, not only for the application's own transactions.
- Revokes membership in every privilege-escalating predefined role
  (`pg_read_all_data`, `pg_write_all_data`, `pg_read_server_files`,
  `pg_write_server_files`, `pg_execute_server_program`, `pg_signal_backend`,
  `pg_monitor`, `pg_maintain`), each guarded by an existence check because that set
  grows with the server version.
- Grants `CONNECT` on the database and `USAGE` on schema `public` — never `CREATE`.
- Revokes all table, sequence, and routine privileges plus default privileges, then
  grants back only the declared `SELECT` allowlist.

**It is safe to re-run, and re-running is the intended path** for rotating the
password and for picking up a new table grant. Because it is declarative, a re-run
also **removes** a grant somebody added by hand — that is deliberate.

### One collateral change to shared database state

PostgreSQL grants `TEMPORARY` on a database to `PUBLIC` by default, and a `PUBLIC`
grant cannot be revoked for a single role. Denying the diagnostics role `TEMP`
therefore requires `REVOKE TEMPORARY … FROM PUBLIC` and granting it back to the
roles that should keep it.

The stock Compose stack is unaffected — its app role is a superuser and bypasses
privilege checks entirely. **A fork whose application role is not a superuser must
list that role (and whoever runs migrations) in
`AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES`** before provisioning, or those roles lose
the ability to create temporary tables.

### What is deliberately not done

`CREATE ON SCHEMA public` is **not** revoked from `PUBLIC`. PostgreSQL 15+ already
denies it, so on a supported server the statement is a no-op, and on an older or
hand-tuned fork it could break a non-superuser app role mid-migration. Instead the
runtime self-check refuses to run any tool if the diagnostics role turns out to hold
schema `CREATE`, so the anomaly is loud rather than silently patched under an
operator's feet.

The script also does not create the database, the app role, or any view.

### Adding a table grant later

A tool pack (AID-6A/B/C) that needs a new table adds its `GRANT SELECT` to
`SELECT_GRANTS` in the same pull request as the tool. Upgrading to that release is
therefore a two-step operation: deploy, then **re-run
`npm run diagnostics:provision-role`**. ADR-007's deliberate friction is exactly
this — a new table becoming readable by Diagnostics is a visible, reviewed, operator
action, not a side effect.

### Rotating the password

Re-run the script with a new `AI_DIAGNOSTICS_DB_PASSWORD`, then update
`AI_DIAGNOSTICS_DATABASE_URL` and restart the app containers. The script re-asserts
every restriction at the same time.

## Reading readiness

`GET /api/admin/ai-diagnostics/readiness` reports metadata only. The
`databaseState` field says what to do next:

| `databaseState` | Meaning | Operator action |
| --- | --- | --- |
| `not_configured` | `AI_DIAGNOSTICS_DATABASE_URL` is not set. Nothing was contacted. | Provision the role and set the variable. |
| `misconfigured` | Set, but unusable as configured: not a valid `postgres://` URL, no username, or it names the **same role** as `DATABASE_URL`. | Fix the connection string; it must be the dedicated role. |
| `unverified` | Set, but the server could not be asked — unreachable host, bad password, connection limit. The role is **not** trusted. | Fix connectivity or credentials, then re-check. |
| `over_privileged` | Reachable, and the server reports the role is **not** least-privilege. | Re-run the provisioning script; investigate how it drifted. |
| `verified` | The server itself confirmed a non-superuser, SELECT-only role. | Nothing. |

The response never contains the connection string, the password, or the role name.

Every state except `verified` blocks readiness, and every diagnostics tool call is
refused independently of readiness — the per-invocation credential gate is the
control, and readiness is the operator-facing explanation of it.

## Connection budget

The diagnostics pool is capped at 3 connections and the role carries its own
`CONNECTION LIMIT`. Count it alongside the Prisma pools when sizing
`max_connections` — see "Connection pool sizing" in
[`DEPLOYMENT.md`](../../DEPLOYMENT.md).

## Verifying it yourself

The repository ships a real-PostgreSQL privilege proof that runs the **shipped**
provisioning statements and then asserts that mutation, DDL, `TEMP`, credential-store
reads, and long queries all fail as the restricted role. To run it against a
throwaway database:

```bash
docker run -d --name aid5-pg -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=concurrency_race_1881 \
  -p 127.0.0.1:55442:5432 postgres:16-alpine

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
  npx prisma migrate deploy

RUN_CONCURRENCY_RACE_TESTS=1 \
CONCURRENCY_RACE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
  npx vitest run src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts
```

The suite refuses to run against port 5432, a non-loopback host, or a database
whose name lacks the dedicated marker. **Never point it at a live database**: it
provisions and drops a cluster role and temporarily revokes
`TEMPORARY … FROM PUBLIC`.

## Related

- [Tool substrate reference](tools.md) — the gates, bounds, audit, and the rules
  for adding a tool.
- [Hub, ADRs, and threat model](README.md).
- [`DEPLOYMENT.md`](../../DEPLOYMENT.md), [`CONFIGURATION.md`](../../CONFIGURATION.md).
