/**
 * AI Diagnostics — THE READ-ONLY DATABASE SEAM every `server_owned` evidence
 * source reads through (AID-7b, #2786; generalised from AID-6B, #2376).
 *
 * WHAT THIS MODULE IS FOR. A `select_only_sql` entry is read-only because
 * PostgreSQL refuses it anything else: it runs as the dedicated `ai_diagnostics_ro`
 * role, on its own pool, and the executor opens `BEGIN READ ONLY` with a
 * `statement_timeout` and a `lock_timeout` around it (`database.ts`). A
 * `server_owned` entry has none of that. It is a first-party calculation running on
 * the APPLICATION's own full-privilege Prisma connection, where a column grant is
 * not the boundary and the SELECT-only role is not involved — so "the agent must
 * remain completely read-only" is, for those entries, a property of the code unless
 * something makes it a property of the server. This seam is that something.
 *
 * `SET TRANSACTION READ ONLY` makes PostgreSQL refuse a write inside this
 * transaction even where the connection's privileges would permit one, with
 * SQLSTATE `25006`. A `server_owned` source that drifts onto a write path
 * therefore FAILS AT THE DATABASE — the executor reports `evidence_unavailable`
 * and nothing is mutated — rather than being caught, or not caught, in review.
 *
 * SO THE BOUND IS AT THE DATABASE, AND SO IS THE DEADLINE. Each evidence source
 * also carries a JavaScript deadline, and a JavaScript deadline is a
 * `Promise.race`: it stops this process WAITING and cancels nothing, because
 * nothing in Prisma propagates a cancellation into an in-flight statement. Before
 * this existed, the ten-second deadline rejected while the hosting sibling fan-out,
 * the member-night conflict scan and the capacity engine went on running against
 * the database — the operator got `evidence_unavailable` and the server kept paying
 * for an answer nobody would read. Under a queue of diagnostics invocations that is
 * how a read-only feature becomes a database incident. A transaction-local
 * `statement_timeout` makes PostgreSQL itself cancel any statement that overruns,
 * and the interactive-transaction `timeout` bounds the whole graph; both fire
 * whether or not this process is still waiting.
 *
 * ONE SNAPSHOT, AND THE ISOLATION LEVEL IS WHAT MAKES IT ONE — not the
 * transaction. An earlier revision of this docblock (in its previous home) claimed
 * the snapshot property while passing no `isolationLevel`, which meant PostgreSQL's
 * default READ COMMITTED: there every STATEMENT takes a fresh snapshot, so being
 * inside one interactive transaction bought ordering and cancellation but not a
 * shared read instant. An administrator over-capacity-confirming another booking
 * between the guest read and the `checkCapacity` call of ONE invocation could still
 * make a row report a party measured at instant A against occupancy measured at
 * instant B, and emit — or omit — `capacity_exceeded` for a state that never
 * existed. Two invocations would disagree with no marker.
 *
 * `REPEATABLE READ` is therefore explicit, and on a read-only transaction it is
 * close to free: one snapshot is registered at the first statement that reads data
 * and every later statement reuses it. It is NOT `Serializable` — that would add
 * predicate locking and a 40001 retry contract this evidence path has no business
 * carrying — and a REPEATABLE READ transaction that performs no write cannot raise
 * a serialization failure at all, because 40001 there arises from write conflicts.
 * `SET TRANSACTION READ ONLY` is orthogonal to isolation and implies no snapshot,
 * which is exactly the confusion the earlier claim rested on. What genuinely
 * remains is that two INVOCATIONS see different snapshots, which every entry's own
 * mixed-instant disclosure states.
 *
 * NO `lock_timeout` HERE, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT. The
 * SELECT-only executor sets one (`DIAGNOSTICS_TOOL_BOUNDS.lockTimeoutMs`) because
 * a diagnostics read must never queue behind a writer. This seam deliberately does
 * not, because #2786 promises no behaviour change to the entries it re-homes and
 * adding one would change when they refuse. The exposure it leaves is bounded by
 * the statement timeout: a read blocked on an `ACCESS EXCLUSIVE` lock is cancelled
 * by PostgreSQL at `DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS` like any other slow
 * statement, so the worst case is a slower refusal, never an unbounded wait.
 *
 * WHAT A CALLER MUST DO WITH `tx`: pass it to every collaborator. A helper that
 * silently fell back to the global client would run outside both the snapshot and
 * the timeout, which is the whole boundary this seam exists to create — so the
 * canonical seams take a client, and no `server_owned` evidence module names
 * `prisma` at all.
 *
 * THAT RULE IS PINNED AT THE SOURCE, not by the unit assertions, because the unit
 * assertions structurally cannot pin it: a new read written on the global client is
 * not a collaborator, so no argument assertion sees it, and it calls the same
 * doubled function the transaction client does. `__tests__/read-only-transaction.test.ts`
 * therefore strips the comments from THIS file and asserts that `prisma.` reaches
 * exactly one property in the remaining code — `$transaction` — and strips every
 * `server_owned` evidence module and asserts `prisma.` reaches NOTHING in them. A
 * second reference in either place has to be argued for in that test.
 *
 * WHAT THE SEAM CANNOT COVER IS DECLARED, NEVER ASSUMED. Some evidence a
 * `server_owned` entry needs cannot be read through a transaction on this
 * connection at all — a readiness verdict that must stay answerable when this
 * connection is the fault, a read that touches no database, a shared helper that
 * takes no transaction client. Those are `READ_ONLY_SEAM_EXEMPTIONS`, which lives in
 * `read-only-seam-exemptions.ts` rather than here because `define.ts` has to check
 * declarations against it and `define.ts` is not `server-only`. It is a closed table
 * with a reason per row, named by each entry's own `readOnlySeam` declaration,
 * refused at definition time if the id does not exist, and pinned by a census test so
 * a sixth exemption is a reviewed decision rather than an accident.
 */

import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { DIAGNOSTICS_TOOL_BOUNDS } from "./types";

/**
 * THE ONE DATABASE BOUND, IN ONE PLACE, IN ONE UNIT.
 *
 * It used to exist in four unlinked representations: a pack-local
 * `AID6B_DATABASE_STATEMENT_TIMEOUT_MS`, a literal `'5s'` inside a `SET LOCAL`
 * statement, hardcoded numbers in the tests, and `DIAGNOSTICS_TOOL_BOUNDS`'s own
 * `statementTimeoutMs` — which the SELECT-only executor has always used and whose
 * docblock has always described exactly this control. Nothing linked any pair.
 * Narrowing one would have left PostgreSQL cancelling at five seconds while the
 * interactive-transaction timeout dropped BELOW it, inverting the design: the
 * database is supposed to refuse first so the operator gets the specific
 * `57014 query_canceled` refusal rather than a Prisma transaction timeout. Every
 * test would still have passed.
 *
 * So both diagnostics database paths now derive from the SAME bound. It is a
 * derivation and not a copy: there is no second literal to keep in step.
 *
 * HOW IT REACHES POSTGRESQL. `SET LOCAL statement_timeout = $1` is invalid — `SET`
 * takes no placeholders — so this uses `set_config(..., is_local => true)`, which
 * takes the value as an ORDINARY BOUND PARAMETER and is therefore expressible as a
 * fixed Prisma tagged template, with no SQL built by string concatenation and no
 * unsafe raw executor. `setTransactionLockTimeout` in
 * `adult-member-hosting-queue-participants.ts` chose it over `SET LOCAL` for exactly
 * this reason and is the precedent. The value is a millisecond integer, which is the
 * unit `statement_timeout` takes bare, and it is stringified because `set_config`'s
 * second argument is `text`.
 */
export const DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS =
  DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs;

/**
 * How much longer the whole transaction may run than any one statement in it.
 *
 * Named rather than inlined so the ORDERING is legible: the ceiling has to sit
 * strictly above the statement timeout, or Prisma's transaction timeout fires
 * first and the operator gets a generic transaction error instead of PostgreSQL's
 * specific cancellation. It is a margin over one statement, not a second bound in
 * its own right, which is why it is small.
 */
const READ_ONLY_TRANSACTION_MARGIN_MS = 2_000;

/**
 * The interactive-transaction ceiling: strictly ABOVE the statement timeout so the
 * database's own cancellation is what a slow read hits, and strictly below every
 * evidence source's JavaScript deadline so this process is still waiting to report
 * it. The ordering statement < transaction < source deadline is asserted rather
 * than assumed.
 */
export const DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS =
  DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS + READ_ONLY_TRANSACTION_MARGIN_MS;

/**
 * How long Prisma may wait for a pool connection before giving up on opening the
 * transaction at all. Unchanged from #2376: a diagnostics read that cannot get a
 * connection within two seconds should refuse, not join the queue that is already
 * the problem.
 */
const READ_ONLY_TRANSACTION_MAX_WAIT_MS = 2_000;

/**
 * Run one `server_owned` evidence read inside a `REPEATABLE READ`, READ ONLY,
 * statement-timed transaction on the application's connection.
 *
 * DO NOT NEST. Opening a second interactive transaction inside the callback would
 * take a second pool connection, a second snapshot and a second timeout — the
 * pool-starvation shape `docs/CONCURRENCY_AND_LOCKING.md` forbids. A sub-read that
 * needs the database takes `tx` from its caller instead.
 */
export async function withBoundedReadOnlyTransaction<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SELECT pg_catalog.set_config('statement_timeout', ${String(DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS)}, true)`;
      return run(tx);
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: READ_ONLY_TRANSACTION_MAX_WAIT_MS,
      timeout: DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
    },
  );
}

/**
 * The closed exemption table this seam's contract depends on lives in
 * `read-only-seam-exemptions.ts`. It is re-exported nowhere on purpose: one home per
 * decision, so a reader who wants to know what is NOT covered goes to the module
 * whose entire subject is that question.
 */
