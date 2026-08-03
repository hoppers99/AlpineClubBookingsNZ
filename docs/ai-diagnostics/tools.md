# AI Diagnostics tool substrate (SELECT-only)

The typed, server-owned, read-only tool substrate that lets AI Diagnostics
retrieve **bounded operational evidence** from the database. Delivered by AID-5
(issue #2374) under epic [#2369](README.md).

Contracts: [ADR-001](decisions/ADR-001-separate-admin-only-diagnostics-product.md)
(read-only, no model SQL),
[ADR-002](decisions/ADR-002-admission-and-per-tool-authorization-lattice.md)
(per-invocation `area:view`),
[ADR-003](decisions/ADR-003-untrusted-evidence-classes.md) (results are untrusted
evidence),
[ADR-004](decisions/ADR-004-sensitive-context-retention-redaction-audit-metadata.md)
(approved audit metadata only),
[ADR-005](decisions/ADR-005-budget-rate-limits-tool-loop-fail-closed.md) (bounded
loop, fail closed),
[ADR-007](decisions/ADR-007-least-privilege-select-only-database-credential.md)
(the least-privilege credential).

Code: `src/lib/diagnostics/tools/`. Operator setup:
[`deployment.md`](deployment.md).

## The one invariant

**The model never supplies SQL.** It cannot write a query, extend one, or name a
table. A tool is a server-owned record that pairs a fixed SQL text with a fixed
parameter binding, a fixed projection, fixed row and byte ceilings, and a fixed
admin-permission requirement. The model may only:

- choose **which** registered tool to call, by id; and
- supply arguments that a `.strict()` Zod schema has already accepted.

Accepted arguments become **positional query parameters** and nothing else. There
is no code path in the substrate that concatenates caller text into SQL.

`.strict()` is not quite total on its own, so the substrate does not rely on it
alone: `__proto__`, `constructor` and `prototype` are refused by an own-property
scan **before** the schema runs. Zod accepts a `JSON.parse`-created `__proto__` and
silently *strips* it, which would make a call that sent one hash identically to a
call that sent nothing — and rejection has to be total, exactly as it is for
[page context](page-context.md).

The scan walks **every depth**, arrays included, and not only the top level. Zod
strips a nested `__proto__` just as readily: measured on zod 4.4.3, a schema of
`{ filters: { status? } }` with both objects `.strict()` accepted
`{"filters":{"__proto__":{…},"status":"open"}}` and returned
`{"filters":{"status":"open"}}`, whose canonical hash is byte-identical to the same
call without the key. A `filters` object is the natural shape for the first tool pack,
so an author adding a nested or record-shaped argument inherits the refusal rather
than having to remember it.

## What AID-5 ships, and what it deliberately does not

AID-5 is the **substrate**. It ships exactly one registered tool — a readiness
probe that reads **no relation at all** and returns only whether the connection is
read-only and what query timeout is in force. Its purpose is to prove the plumbing
end to end (the dedicated role connects, the transaction really is `READ ONLY`, the
timeout is set, authorization runs, the audit row is written) without exposing one
row of club data.

The domain tools arrive in their own children so each gets its own permission
review and its own table grant: AID-6A (#2375, config/readiness), AID-6B (#2376,
booking/membership/induction/bed allocation), AID-6C (#2377, finance/Xero).

The `SELECT` grant allowlist is therefore **empty** today. Every table in the
schema, including `IntegrationCredential`, is unreadable by the diagnostics role.

## The ten gates, in order

`invokeDiagnosticsTool` (`invoke.ts`) is the only entry point. The order is the
contract, and none of the gates can be reached out of order. Every exit returns a
typed result carrying **no rows**.

| # | Gate | Refuses when |
| --- | --- | --- |
| 1 | **Registry** | the id is not a well-formed key, or names no server-owned entry |
| 2 | **Loop budget** | no round is open, or the round/session tool-call allowance is spent |
| 3 | **Authorize** | the caller's freshly re-read matrix lacks `view` on **any** area the tool declares, or their account is locked out |
| 4 | **Arguments** | the entry's `.strict()` schema rejects them, or they carry a reserved key |
| 5 | **Metering** | AID-2's metering circuit breaker is open |
| 6 | **Credential** | the dedicated role is absent, malformed, carries a connection parameter that would redirect it, is the app's own role, is unverifiable, or is over-privileged |
| 7 | **Read** | the entry's parameters do not match the `$n` its SQL references, the statement fails, or the statement timeout cancels it |
| 8 | **Project** | the projection returns anything that is not a flat scalar, or too many fields |
| 9 | **Size** | the projected result exceeds the tool's byte ceiling — a **refusal**, never a silent trim |
| 10 | **Audit** | the approved-metadata row cannot be written — the evidence is then discarded |

Two ordering choices are load-bearing:

- **Authorization runs before argument parsing.** Parsing first would let an
  unauthorized caller use the difference between "invalid arguments" and
  "permission denied" as an oracle for a tool's argument shape. It also means an
  unauthorized invocation never opens a database connection.
- **The audit row is written before any evidence is returned.** An unauditable
  evidence retrieval is what ADR-004 exists to prevent, so it is not an outcome
  the substrate offers.

The loop budget is claimed even for a call that is about to be denied — including a
call naming an id that is **not in the registry** — so a caller cannot probe for
free, round after round. Without that, one provider round of sixty hallucinated ids
would write sixty audit rows with the round budget never engaging.

## Authorization is per invocation, and withholding is not authorization

Every invocation re-reads the caller's effective permission matrix from the
database-joined access roles — never a JWT, never a session snapshot, never a memo
— and requires `view` on **every** area the tool declares (AND, never OR). A role
revoked mid-session takes effect on the very next tool call, and round two of a
multi-tool loop is authorized exactly as strictly as round one. The reader is
AID-4's `readFreshAdminPermissionMatrix`, deliberately reused rather than copied:
one function in the codebase does this, so a second copy cannot drift and quietly
widen access.

`definitions.ts` hides tools the caller cannot use from the model. That is a
**usability** property, so the model does not offer an operator something they will
be refused. It is **not** a security control. An invocation naming a withheld tool
id — because the model hallucinated it, because a request was replayed, or because
a role was revoked between the definition list and the call — is authorized and
denied on its own merits.

## Bounds

Every ceiling lives in `DIAGNOSTICS_TOOL_BOUNDS` (`types.ts`). A registry entry may
be **stricter** than the global ceiling, never looser, and a contract test refuses a
looser one.

| Bound | Value | Enforced by |
| --- | --- | --- |
| Rows per tool | 200 | the executor's own outermost SQL `LIMIT` |
| Result bytes per tool | 32,768 | canonical-JSON byte count, as a refusal |
| Characters per field | 200 | post-redaction cap in the projection |
| Fields per row | 24 | projection contract check |
| `statement_timeout` | 5,000 ms | `SET LOCAL` per transaction **and** on the role |
| `lock_timeout` | 2,000 ms | `SET LOCAL` per transaction |
| `idle_in_transaction_session_timeout` | 10,000 ms | `SET LOCAL` per transaction |
| Client-side query deadline | 10,000 ms | pg's `query_timeout` on the pool |
| Role privilege re-verification | every 60,000 ms | the server is re-asked; the verdict is cached no longer |
| Privilege-probe deadline | 12,000 ms | explicit race, so an unanswered probe refuses rather than hangs |
| Tool calls per provider round | 4 | server-side session counter |
| Tool calls per session | 16 | server-side session counter |
| Provider rounds | AID-2's `DIAGNOSTICS_MAX_TOOL_ROUNDS` | server-side session counter |
| Pool connections | 3 | the dedicated `pg` pool, plus the role's `CONNECTION LIMIT` |
| Rendered evidence block | 8,000 chars | truncated tail, with an explicit in-block notice |

The row cap is applied **in SQL**, as the outermost clause wrapped around the
entry's own statement, so a tool that forgot a `LIMIT` is still bounded by the
database. The executor asks for `rowLimit + 1` rows so it can report truncation
honestly rather than guess at it.

Because the cap is appended as the **next** `$n`, an entry must bind exactly as many
parameters as its SQL references. One short is not an error the database raises: the
row-cap value silently serves as the missing placeholder, so the tool's own predicate
would be evaluated against the row cap and the result projected, hashed and audited as
a clean success. Both a registry contract test and the executor refuse that
mismatch — the executor before it opens a transaction.

The three timeouts stack in a deliberate order: the **server's** own
`statement_timeout` fires first, so a slow read is reported honestly as SQLSTATE
`57014`; the client-side `query_timeout` is the backstop for a connection that can
never reply at all (a black-holed route, a wedged pooler); and the probe deadline is
the backstop for that. Without the client-side layer an unanswered privilege probe
stayed pending — and because the verdict is cached, every later readiness request
joined the same pending promise.

The tool-call session (`session.ts`) is an explicit per-question object, not
ambient state: a module-level counter would either leak between concurrent admins
or reset per process, and both are limits that are not really limits. Limit
overrides are clamped **downwards only** — a caller cannot widen the loop.

## The read itself

Each read runs as the dedicated SELECT-only role, inside an explicit
`BEGIN READ ONLY` transaction, with its own `statement_timeout`, `lock_timeout`,
`idle_in_transaction_session_timeout`, and `search_path` pinned to `public` so a
role- or database-level `search_path` cannot redirect an unqualified relation name.

`READ ONLY` at the transaction level is the database's own refusal of every write,
DDL, and `TEMP` statement (SQLSTATE `25006`), independent of the role's grants — so
**both** layers have to fail before a write is possible. That layering is proven,
not assumed: the real-PostgreSQL suite deliberately over-grants `INSERT` on a
scratch table and shows the read-only transaction refuses the write anyway.

This is the only place in the codebase that connects with the diagnostics
credential, and it deliberately does not go through `@/lib/prisma`. A raw `pg` pool
is what allows the transaction-scoped session settings above; and the application's
Prisma client is bound to `DATABASE_URL`, whose Compose role is a **superuser**.

A PostgreSQL error message can quote the failing statement and its parameter values
verbatim, so the driver's message is **discarded** rather than routed anywhere: the
caller gets a fixed sentence, the audit row gets none of it, and the log and Sentry
get the SQLSTATE plus the server-owned tool id. A statement timeout is logged but
deliberately **not** bridged to Sentry — it is an expected, operator-triggerable
outcome, and one error-level alert per heavy question is the alert-fatigue trap
#1150 rejected.

The connection string itself is refused if it carries a query parameter that would
override what was vetted — `user`, `password`, `host`, `port`, `options`, the three
timeouts, or `replication`. `pg` reads those in preference to the URL's own userinfo
and over the pool's explicit options, so `?user=` would let the driver connect as the
application role while the gate below vetted the dedicated one. The connected role is
then re-checked against the server's own `current_user` as well.

## Results are untrusted evidence

A tool result carries no system authority. `render.ts` wraps it in an
untrusted-evidence block that belongs in the **user** turn — never the system role.
Angle brackets are stripped from every untrusted span and the wrapper token is
defused, so a value containing `</diagnostics_tool_result>` cannot close the block
and continue as prompt. The block is deterministic (the observed-at instant comes
from the result, not a clock) and hard-capped.

**Section order is a safety property.** Truncation takes the tail, so the framing,
the tool identity, and the truncation/failure notices are rendered *before* the
rows: a large result can only ever cost rows, never the notice that tells the model
the set is incomplete. The closing delimiter is never cut.

A **failure** renders too. "The tool did not run, and here is why" is the evidence
that stops the model inventing an answer, and it is the only thing that makes a
permission denial visible in the transcript the operator reads.

## Audit: approved metadata only

One `AuditLog` row per invocation, action `ai_diagnostics.tool_invocation`,
category `security`, retention class `sensitive_access` (24 months) — the same
class the platform gives its other admin data-access events. `AuditLog` is reused
rather than given a parallel table because it already has the retention
classification, the expiry/archive pipeline, the admin query surface, and the
archive runbook.

Recorded, exhaustively: tool id, the areas checked, the auth outcome, the failure
reason, a sha256 of the canonical JSON of the **accepted** arguments, a sha256 of
the canonical JSON of the projected rows, row count, byte count, duration, round
index, observed-at.

Never recorded: raw arguments, raw results, the operator's question, the model's
answer, provider payloads, credentials, or any identifier beyond the acting admin's
own member id. The metadata object is built field by field on purpose — spreading
the audit object would have been shorter and would let a future field sweep into a
durable row without anyone thinking about ADR-004.

Arguments the schema **refused** are never hashed and never stored: there is no
canonical form of input we declined to understand, and hashing the raw input would
put operator-supplied text into a durable row.

The audit write uses the ordinary application connection. The SELECT-only role
cannot write, by design; ADR-001 §3 already lists metering and audit metadata as
the one permitted write class. Two connections, two capabilities, no overlap.

## Fail-closed reasons

Every reason returns no rows and carries a plain-English operator sentence that
never echoes caller input: `unknown_tool`, `invalid_args`,
`call_budget_exhausted`, `metering_unavailable`, `actor_unresolved`,
`actor_blocked`, `actor_read_failed`, `permission_denied`,
`database_not_configured`, `database_role_unsafe`, `query_failed`,
`result_too_large`, `redaction_failed`, `audit_unavailable`, `internal_error`.

Several distinctions are deliberate. `unknown_tool` and `permission_denied` stay
separate so a misconfigured registry and an authorization anomaly are not the same
audit row. The three actor reasons stay separate for the same reason:
`actor_unresolved` is a stale or forged acting member id, `actor_blocked` is an
account deliberately locked out of the admin surface (deactivated, or under a forced
password change — the same cause page context reports as `actor_blocked`), and
`actor_read_failed` is a database fault. They are held apart by a total map over the
reader's failure codes, so a new code cannot compile until it has been given a reason
of its own. `internal_error` exists because a collaborator that throws where its
contract says it returns a typed refusal is a bug — and losing the audit trail to an
escaping exception would be a worse one.

A fault that happens **after** authorization succeeded is audited as what it was: an
`allowed` call that then failed, with the areas it checked and the hash of the
arguments it accepted intact. Only a fault before or during authorization is recorded
as `denied`, which is what `audit.ts` turns into a `blocked` outcome.

## Adding a tool

The checklist a reviewer should hold you to:

1. `requiredAreas` names the area(s) that already govern this data in the admin UI,
   at `view`. A cross-area tool lists **every** area (AND).
2. `sql` is one statement, no semicolon, schema-qualified, parameterised.
3. `bind` maps parsed arguments to parameters positionally; it never formats SQL, and
   it returns exactly as many parameters as the SQL references (`$1..$N`, no gaps).
   Add the entry's representative arguments to `EXAMPLE_ARGS` in `registry.test.ts` so
   that arity is actually checked.
4. `project` returns **only** allowlisted columns, as flat scalars.
5. Add the table's `GRANT SELECT` to `SELECT_GRANTS` in `provision-role.ts` in the
   **same** pull request — never a blanket `ALL TABLES IN SCHEMA` grant — and an
   operator re-provisions as part of that upgrade.
6. `surfacesPersonalData` is true if any projected field identifies a person;
   ADR-004 §1 then requires a per-invocation opt-in from the operator.

Secret-bearing relations (credentials, tokens, password/2FA, sessions) and raw
provider-payload stores are permanently out of scope (ADR-007 §1).

`registry.test.ts` refuses an entry whose SQL contains a mutation, DDL,
file-reading function, locking clause, `SET`, or a semicolon. That is a
**review-time** guard, not a runtime sanitiser: the runtime guarantee is that the
SQL is server-owned and the role cannot write.

## Proof

Mocks cannot establish any of ADR-007's claims — they are claims about
PostgreSQL's own behaviour. `src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts`
provisions the role by running the **shipped** statements from `provision-role.ts`
against a real PostgreSQL, connects as that role, and proves:

- the role is a non-superuser with no DDL, replication, or RLS-bypass attribute,
  and no membership in **any** role — tested with `pg_has_role(…, 'MEMBER')`, because
  the role is `NOINHERIT` and the `'USAGE'` predicate reports a hand-granted
  membership as absent;
- it holds no table privilege at all on the migrated schema, and although PUBLIC
  leaves it able to EXECUTE the schema's routines, none of them is
  `SECURITY DEFINER`;
- it can execute no overload of `pg_read_file`, `pg_read_binary_file`, `pg_ls_dir`,
  `pg_stat_file`, `lo_import` or `lo_export`;
- `INSERT`, `UPDATE`, `DELETE`, and `TRUNCATE` fail with insufficient privilege
  (`42501`) even with the read-only default switched off, so the assertion proves
  the **grant** layer specifically;
- `CREATE TABLE`, `CREATE TEMP TABLE`, `CREATE SCHEMA`, `CREATE INDEX`,
  `ALTER TABLE`, `DROP TABLE`, `CREATE FUNCTION`, `CREATE ROLE`, and
  `ALTER ROLE … SUPERUSER` all fail with `42501`;
- the encrypted credential store and every un-granted table are unreadable, a
  table created after provisioning is unreadable, and the role cannot grant itself
  access;
- re-running the provisioning statements **revokes** a hand-added grant and a
  hand-added role membership, and is otherwise idempotent;
- a granted `INSERT` is still refused inside the read-only transaction (`25006`)
  and from the role's own default;
- the runtime self-check accepts the provisioned role and **refuses a real
  superuser credential**;
- it also refuses that same role the moment it drifts: a hand-granted
  `pg_read_all_data` membership (proven reachable with one `SET ROLE`), a membership in
  an **ordinary** application role or in a superuser role — neither of which any other
  column of the self-check can see, both proven reachable with one `SET ROLE`, and both
  stripped by re-provisioning — a write grant on any relation, a readable relation the
  allowlist does not declare, EXECUTE on a non-default `pg_read_file` overload, or a
  `SECURITY DEFINER` routine in `public` that re-provisioning cannot revoke;
- a verdict that has aged out is re-read from the server, so a role escalated while
  the process is running stops being accepted;
- the executor's SQL row cap holds whatever the query would have returned, a long
  query is cancelled at the statement timeout (`57014`), and an entry that binds one
  parameter short is refused — with the same statement shown returning rows, and the
  wrong ones, when the guard is not there.

The suite is opt-in (`RUN_CONCURRENCY_RACE_TESTS=1` plus a loopback-only,
high-port, dedicated-name database) and `describe.skip`s itself otherwise, so it
never touches a developer's database. Because a skipped suite is a silent no-op,
`review-findings-contracts.test.ts` pins the CI step, its environment, and its
ordering after the migrate step — the proof cannot be unplugged without a test
failing.

## Related

- [Deployment and operator guide](deployment.md) — provisioning the role, rotating
  the password, and what readiness reports.
- [Page context](page-context.md) — the other evidence channel (AID-4).
- [Knowledge bundle](../diagnostics/KNOWLEDGE_BUNDLE.md) — the deployed-code
  evidence channel (AID-3).
- [Hub and ADR index](README.md).
