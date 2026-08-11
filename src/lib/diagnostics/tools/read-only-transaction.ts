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
 * NOR AN `idle_in_transaction_session_timeout`, and for a different reason than the
 * one below. The SELECT-only executor sets one because that path holds a transaction
 * open across a network round trip it does not control. This seam does not: the
 * callback is ordinary in-process code between `BEGIN` and `COMMIT`, so the interval
 * that setting protects against — a transaction left open while nothing runs — is
 * already bounded by the interactive-transaction `timeout` below, which fires whether
 * the process is busy or idle. Adding a second bound over the same interval would be
 * two numbers to keep in step for one hazard.
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
 * doubled function the transaction client does. Nor can the pack tests' escape
 * recorders pin it — those record only while a transaction callback is OPEN, so a
 * read placed BEFORE the seam, or one in an entry that opens no seam at all, is
 * invisible to them. That pre-seam shape is not hypothetical: it is what produced
 * the module-flags exemption.
 *
 * `__tests__/read-only-transaction.test.ts` therefore strips the comments from THIS
 * file and asserts that `prisma.` reaches exactly one property in the remaining code
 * — `$transaction` — and does the same to EVERY module in `packs/`, discovered by
 * reading the directory rather than from a list, asserting `prisma.` reaches nothing
 * in any of them. A list was the first attempt and it silently omitted
 * `support-evidence.ts`, which is exactly how a census stops being one.
 *
 * AND THE SERVER ITSELF IS ASKED, because everything above is still only this
 * process's intent. `src/lib/__tests__/ai-diagnostics-readonly-seam.realdb.test.ts`
 * opens this seam against a real PostgreSQL and asserts what the SERVER reports:
 * `transaction_read_only` is `on`, the isolation level really is `repeatable read`,
 * `statement_timeout` really took, an INSERT is refused with SQLSTATE `25006` on a
 * connection whose privileges would otherwise permit it, and the timeout is RELEASED
 * at commit instead of leaking onto the pooled application connection. A mock cannot
 * distinguish a working `set_config` from a no-op; that suite can.
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
 * TWO NAMES FOR ONE BOUND, ON TWO DIFFERENT PATHS. The pack declared
 * `AID6B_DATABASE_STATEMENT_TIMEOUT_MS = 5_000` for the `server_owned` path, and
 * `DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs` — also 5 000 — has always bounded the
 * `select_only_sql` path, its docblock describing exactly this control. Nothing
 * linked them.
 *
 * BE PRECISE ABOUT WHAT THAT RISKED, because an earlier draft of this comment
 * overstated it (#2786 review). Within the pack the two were already safe from each
 * other: `AID6B_TRANSACTION_TIMEOUT_MS` was DERIVED as the statement timeout plus two
 * seconds, so narrowing the statement bound moved the ceiling with it and the
 * ordering could not invert. The real exposure was ACROSS the two paths — tighten the
 * substrate's bound because SELECT-only reads were hurting the database, and the
 * server-owned reads, which run on the application's full-privilege connection and
 * are the heavier of the two, would have gone on cancelling at the old five seconds
 * with every test still green. One diagnostics feature would have had two different
 * ideas of how long a read may take, and the more dangerous path would have kept the
 * looser one.
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
 * The interactive-transaction ceiling: strictly ABOVE the statement timeout so the
 * database's own cancellation is what a slow read hits, and strictly below every
 * evidence source's JavaScript deadline so this process is still waiting to report
 * it. The ordering statement < transaction < source deadline is asserted rather
 * than assumed.
 *
 * The margin that produces it moved into `types.ts` with the rest of the ladder
 * (#2804), because the source deadline and the executor's outer race now DERIVE
 * from it too — and a margin that three bounds depend on cannot live in the one
 * module that only needs two of them.
 */
export const DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS =
  DIAGNOSTICS_TOOL_BOUNDS.readOnlyTransactionTimeoutMs;

/**
 * How long Prisma may wait for a pool connection before giving up on opening the
 * transaction at all.
 *
 * WAS TWO SECONDS, AND THE REASONING FOR THAT WAS NEVER REALLY TESTED. It came
 * from #2376 as "a diagnostics read that cannot get a connection within two
 * seconds should refuse, not join the queue that is already the problem" — which
 * sounds right and quietly assumed the queue is always pathological. Usually it
 * is not: it is a second admin looking at a page. Owner decision #2804 is that an
 * admin would rather wait for a busy database than be told to try again, so this
 * is now twenty seconds, and a read that gives up says `evidence_database_busy`
 * rather than being folded in with a genuine fault.
 *
 * It stays FINITE, and that is not a compromise on the decision — it is the
 * decision's own limit. An unbounded queue of readers each holding a pool slot is
 * precisely the incident this seam exists to prevent, and Prisma requires a number
 * regardless.
 */
const READ_ONLY_TRANSACTION_MAX_WAIT_MS =
  DIAGNOSTICS_TOOL_BOUNDS.readOnlyMaxWaitMs;

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
 * Did this failure mean "the database was too busy to even start", as opposed to
 * "the read ran and something went wrong"? (#2804)
 *
 * Prisma raises `P2024` when `maxWait` expires without a free pool connection.
 * That is the ONE failure on this path where nothing is broken — the database is
 * reachable, the query is fine, every connection was simply in use — and it is
 * therefore the one an operator must not be sent to debug.
 *
 * IT MATTERS MORE NOW THAN IT DID. At a two-second wait this was a rare event
 * folded into the generic refusal without much cost. At twenty seconds, an admin
 * who has watched a spinner for twenty seconds is owed an accurate reason for it,
 * and "the system evidence could not be gathered" would send them looking for a
 * fault that does not exist.
 *
 * MATCHED ON THE CODE, NOT THE MESSAGE. `P2024`'s human text has been reworded
 * across Prisma releases and is not a contract; the code is. The `instanceof`
 * check is deliberately avoided in favour of a structural read, because a driver
 * adapter can wrap the error and `instanceof` then quietly stops matching — which
 * would silently reclassify every busy refusal as a fault, in the direction that
 * loses information rather than the direction that fails loudly.
 */
export function isDiagnosticsPoolWaitTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "P2024") return true;
  // The adapter wraps the original; check one level down rather than reaching
  // arbitrarily deep, so this cannot start matching something unrelated.
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { code?: unknown }).code === "P2024";
}

/**
 * The closed exemption table this seam's contract depends on lives in
 * `read-only-seam-exemptions.ts`. It is re-exported nowhere on purpose: one home per
 * decision, so a reader who wants to know what is NOT covered goes to the module
 * whose entire subject is that question.
 */
