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

The refusal is not a configuration check that trusts the URL. The application asks
the **server** what the connected role actually is and actually holds, and refuses
every tool call unless the answer is the least-privilege shape ADR-007 requires:

- it is the same role the connection string names (`current_user`, not the URL's
  claim);
- no `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS` attribute;
- no `TEMPORARY` or `CREATE` on the database, and no `CREATE` on schema `public`;
- no `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` on any relation in `public`, at table
  or column level;
- no `SELECT` on any relation in `public` that the declared allowlist does not name —
  which in this release is **every** relation, since the allowlist is empty;
- no membership in **any** other role — not a shortlist of dangerous ones, a total of
  zero. A member of any role is one `SET ROLE` away from that role's privileges, and
  because this role is `NOINHERIT` the membership shows up in nothing else the server
  is asked: `GRANT tac_app TO ai_diagnostics_ro` leaves every other answer above
  clean, and one `SET ROLE tac_app` then reads `IntegrationCredential` and writes
  `Booking`. Membership is tested as membership rather than as inherited usage for the
  same reason, and it is counted through chains as well as direct grants, because
  `SET ROLE` reaches a role granted two hops away. When the granted role is one of the
  privilege-escalating predefined roles (`pg_read_all_data` and the rest), the refusal
  logged on the server names it, because that is a more useful sentence than a count.
  The readiness screen does not: it reports `over_privileged` and no privilege detail
  at all, by design, since it is JSON an admin browser receives. Ordinary role names
  are not logged either — only the eight predefined names, which are PostgreSQL
  built-ins rather than anything about this deployment;
- no `EXECUTE` on any overload of `pg_read_file`, `pg_read_binary_file`, `pg_ls_dir`,
  `pg_stat_file`, `lo_import` or `lo_export`;
- no `EXECUTE` on a `SECURITY DEFINER` routine in `public` (see "What is deliberately
  not done").

That answer is **re-read from the server at least once a minute**, not cached for the
life of the container. A role that was hand-edited back towards write access stops
being accepted within a minute, and the readiness screen changes with it — no restart
required. If the server cannot be asked, the role is not trusted: the state becomes
`unverified` and every tool call is refused. It never hangs waiting, either.

The connection string is also refused outright if it carries a query parameter that
would override what was checked — `user`, `password`, `host`, `port`, `options`,
`statement_timeout`, `query_timeout`, `lock_timeout`,
`idle_in_transaction_session_timeout` or `replication`. The PostgreSQL driver reads
those in preference to the URL's own username and over the application's own pool
settings, so a URL of the form
`postgresql://ai_diagnostics_ro:…@host/db?user=tac_app&password=…` would otherwise
pass the "not the application role" check and then connect as the application role.
Ordinary parameters such as `sslmode` and `connection_limit` are unaffected.

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
| `AI_DIAGNOSTICS_DB_ROLE` | no | Role name. Defaults to `ai_diagnostics_ro`. Refused if it equals the provisioning role, or if it is not a supported identifier (below). |
| `AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES` | no | Comma-separated roles that must keep `TEMPORARY` on the database (see below). Defaults to the provisioning role, so a deployment whose **application** role name is unsupported must set this explicitly. |

**Supported identifiers.** Every role and database name the script interpolates must
be letters, digits and underscores only, starting with a letter or underscore, at most
63 characters. That is narrower than PostgreSQL allows: these names are also emitted as
SQL literals inside dollar-quoted `DO $$ … $$` blocks, where a `$` would end the block
early. A managed-provider name such as `tac-app` (AWS RDS) or `user@server` (Azure
Database for PostgreSQL) is therefore refused, with a message naming the variable that
carried it. Create the diagnostics role under a supported name, and for
`AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES` see the `TEMPORARY` note below — a superuser
application role does not need listing at all.

Then set the connection string in the deployment environment (the Compose `.env`):

```
AI_DIAGNOSTICS_DATABASE_URL=postgresql://ai_diagnostics_ro:<password>@postgres:5432/tacbookings?connection_limit=3
```

Compose passes it through to the app containers. Leave it empty and Diagnostics
stays not-ready; there is no unsafe default.

### What provisioning does

It runs one transaction, so a failure part-way leaves no partially privileged role
behind. The statements are **declarative, not additive**: every role membership, and
every table, sequence, and routine privilege, is revoked from the role before the
declared allowlist is granted back. The allowlist lives in
`src/lib/diagnostics/tools/provision-role.ts`, in public code, so "which tables can
Diagnostics read" is answered by reading one file.

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
  `pg_monitor`, `pg_maintain`). A role that does not exist on this server (the set
  grows with the version — `pg_maintain` is PostgreSQL 17+) simply has no membership to
  revoke.
- Then revokes **every remaining membership**, whatever it is in. That is the actual
  control; the named list above documents what it is for. Only the direct grants need
  revoking — a chain always starts with one — so stripping them removes the two-hop
  case too.
- **Every one of those revokes names the grantor that made the grant, and the result is
  re-checked before the transaction is allowed to commit.** This is not a detail. A
  membership is recorded per grantor, and `REVOKE <role> FROM <member>` without
  `GRANTED BY` removes only the grant the *current* role made — even for a superuser.
  Anybody else's grant survives, and PostgreSQL reports that as a `WARNING` while still
  returning success, so the repair would have looked like it worked and left the role
  one `SET ROLE` from the privileges it was supposed to lose. The statement list
  therefore revokes each recorded grant with its own grantor and then raises an error
  if any membership is still recorded, which rolls the whole transaction back.
- Two consequences worth knowing. First, if the provisioning credential may not revoke
  another role's grant, the run fails loudly (`permission denied to revoke privileges
  granted by role "…"`) rather than half-succeeding: that credential cannot produce a
  role the runtime would accept, so the failure is the right answer. Second, the script
  now prints whatever the server said at `WARNING` level and above, and only claims
  memberships were stripped when it said nothing.
- Grants `CONNECT` on the database and `USAGE` on schema `public` — never `CREATE`.
- Revokes all table and sequence privileges plus default privileges, then grants back
  only the declared `SELECT` allowlist.
- Revokes the role's own routine privileges. Note what that does **not** do:
  PostgreSQL grants `EXECUTE` on every function to `PUBLIC` by default and a `PUBLIC`
  grant cannot be revoked for one role, so the diagnostics role can still call the
  schema's functions. What contains that is the read-only transaction plus the runtime
  self-check, which refuses the role if it can execute any `SECURITY DEFINER` routine
  in `public` — the one shape that would run with its owner's privileges. This
  schema's functions are all ordinary trigger functions, so the count is zero.

**It is safe to re-run, and re-running is the intended path** for rotating the
password and for picking up a new table grant. Because it is declarative, a re-run
also **removes** a grant, or a role membership, somebody added by hand — that is
deliberate.

**The one refusal re-provisioning cannot repair: don't make the diagnostics role a
database owner.** `pg_database_owner` is an implicit membership — PostgreSQL treats
whoever owns the current database as a member of it, with no row recorded and nothing
to revoke. A diagnostics role that owns its own database therefore reports one
membership, is refused at runtime, and stays refused however many times the
provisioning is re-run. Nothing in the documented deployment does this (the role is
created by the provisioning script and never owns a database), and the fix is to give
the role no ownership rather than to relax the membership rule: an owner can `SET ROLE
pg_database_owner`, and in this schema `public` is owned through exactly that role. The
provisioning deliberately does not raise on it, so the situation is a runtime refusal
an operator can diagnose rather than a provisioning run that can never succeed.

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
| `misconfigured` | Set, but unusable as configured: not a valid `postgres://` URL, no username, it names the **same role** as `DATABASE_URL`, or it carries one of the refused query parameters above. | Fix the connection string; it must be the dedicated role, with no overriding parameters. |
| `unverified` | Set, but the server could not be asked — unreachable host, bad password, connection limit, or no answer inside the probe deadline. The role is **not** trusted. | Fix connectivity or credentials, then re-check. |
| `over_privileged` | Reachable, and the server's answer is not acceptable: the role holds a privilege ADR-007 forbids, can read a relation the allowlist does not declare, or is not even the role the connection string names. | Re-run the provisioning script and investigate how it drifted. If the role name in the string does not match `current_user`, fix the string. |
| `verified` | The server itself confirmed the named role is a non-superuser that can only `SELECT`, and only from the declared allowlist. | Nothing. |

The response never contains the connection string, the password, or the role name.

Every state except `verified` blocks readiness, and every diagnostics tool call is
refused independently of readiness — the credential gate is the control, and readiness
is the operator-facing explanation of it. Both read the same server answer and age it
out on the same one-minute clock, so the screen cannot report green while the executor
refuses.

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
