# ADR-007: A Dedicated Least-Privilege SELECT-Only Database Credential

## Status

Accepted — the owner-ratified AID-1 foundation merged through PR #2529 on
2 August 2026.

**Governance:** no implementation child (#2371–#2379) may weaken the contract in
this ADR without an owner decision recorded on-repo. In particular, AID-5
(#2374) — the SELECT-only tool substrate — is built against this contract.

## Context

The application's own database role, as provisioned in the Compose stack, is a
**superuser** (confirmed at the epic's `723a90c9` review). Diagnostics runs
data-retrieval tools that execute queries derived from operator questions. If
those tools ran on the application's `DATABASE_URL`, a single flaw — a query
built less carefully than intended, a tool that read a table it should not, an
injection that slipped a wrapper — would run with superuser rights: it could read
the encrypted credential store, write, or escalate. The Page help lane avoided
this entirely by having **no** database tools; Diagnostics cannot, so it needs a
database identity that is structurally incapable of the damage.

## Decision

### 1. A separate, non-superuser, SELECT-only role — never `DATABASE_URL`

The Diagnostics tool substrate (#2374) connects with a **dedicated database
credential that is not the application's `DATABASE_URL`** and is **not** a
superuser. The role is provisioned with:

- **SELECT-only** privileges — no INSERT/UPDATE/DELETE/DDL, no function-execution
  that mutates, no role management;
- privileges on an **explicit allowlist** of tables/views only — never a blanket
  grant, and never on secret-bearing tables (`IntegrationCredential`, token,
  password, 2FA, session tables) or raw provider-payload stores;
- read via **read-only transactions** with a **statement timeout**, so a heavy or
  runaway query cannot exhaust the database;
- ideally the read is confined to purpose-built, typed views that expose only the
  columns a tool needs, so column-level exposure is a schema fact, not a query
  discipline.

The metering, audit, and rate-limit **writes** of ADR-001 §3 do **not** use this
role — they are ordinary first-party writes on the application's own path. The
SELECT-only role reads evidence and nothing else.

### 2. This is defence-in-depth beneath the tool contract, not a substitute for it

The SELECT-only role backstops — it does not replace — ADR-001 (no model SQL,
fixed typed parameterised queries), ADR-002 (per-call `area:view` re-check), and
ADR-003 (bounded excerpts). Even if every other control failed, the worst a
Diagnostics query could do is read an allowlisted, non-secret table, read-only,
under a timeout. Conversely, the least-privilege role never excuses a tool from
its permission gate: a tool the caller is not authorized for never runs, even
though the role *could* physically read the rows.

### 3. Provisioning is a deployment concern, documented generically

The role's creation, grants, and connection string are deployment/operational
setup (a migration/bootstrap step and an environment value), documented in the
subsystem's deployment/operator docs (see the hub's documentation table) and in
`DEPLOYMENT.md`, in the generic, deployment-owned style of ADR-006 — public code
describes the *required shape* of the role, never a specific deployment's
secret.

## Consequences

### Positive

- A defect anywhere in the tool path is contained to allowlisted, non-secret,
  read-only rows under a timeout — the credential store and all mutation are
  structurally out of reach.
- The database itself enforces the read-only, allowlisted boundary, independent of
  application-layer correctness.

### Negative

- Deployments must provision and manage a second database role and connection
  string (documented; a one-time bootstrap step).
- Adding a new tool that reads a new table requires an explicit grant/view change,
  not just application code — deliberate friction that keeps the allowlist honest.

## Related

- ADR-001 (no model SQL; fixed typed queries; named writes use the app path, not
  this role)
- ADR-002 (permission gate still applies even though the role could read the rows)
- ADR-003 (bounded excerpts leave the substrate)
- ADR-006 (generic, deployment-owned provisioning)
- [Threat model](../threat-model.md) — "Elevation of privilege" and the database
  trust boundary.
- [`../../../DEPLOYMENT.md`](../../../DEPLOYMENT.md)
