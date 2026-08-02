import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * The Prisma interactive-transaction client — the module client minus the
 * lifecycle/composition methods a `$transaction` callback cannot call. Every
 * repository helper that runs "inside the caller's transaction OR opens its own"
 * threads a value of this type; sharing one definition keeps the tx-accepting
 * booking services, the capacity engine and the exception-execution seam in step.
 *
 * Defined over the `PrismaClient` CLASS (default generics) and — matching this
 * codebase's existing transaction-client aliases and the type Prisma infers for
 * an interactive `$transaction` callback here — it retains `$transaction`. The
 * many in-tree helpers this value is threaded to (`WorkPartyDbClient`,
 * `BedAllocationLifecycleDb`, the booking-modify `TransactionClient`, …) all
 * require `$transaction` in their param type, so a client that dropped it would
 * not be assignable to them. `withOptionalTransaction` never actually calls
 * `$transaction` on the value.
 */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$use" | "$extends"
>;

/**
 * Run `fn` inside the caller's transaction when one is supplied, otherwise open
 * a fresh `prisma.$transaction`.
 *
 * This is the single seam that makes `createConfirmedBooking` and
 * `modifyBookingBatch` transaction-aware (#2525) without duplicating their
 * bodies: standalone callers pass no `tx` and get a self-contained transaction —
 * behaviour byte-identical to before — while the atomic approve-and-execute
 * path passes ITS transaction so the reservation release, the request-status
 * claim and the canonical booking write all commit together, closing the
 * mark-approved-then-call-service gap.
 *
 * IMPORTANT: when a caller `tx` is supplied the callback runs to completion but
 * the caller still owns the COMMIT. A service that also performs post-commit
 * provider calls (email, Xero, Stripe) must therefore DEFER those to the caller
 * rather than firing them the instant this returns — see the `deferredPostCommit`
 * thunks the two services attach in tx-mode. Do not perform an external side
 * effect immediately after this resolves in tx-mode; the enclosing transaction
 * has not committed yet.
 */
export async function withOptionalTransaction<T>(
  tx: PrismaTransactionClient | undefined,
  fn: (tx: PrismaTransactionClient) => Promise<T>,
): Promise<T> {
  if (tx) {
    return fn(tx);
  }
  return prisma.$transaction((innerTx) =>
    fn(innerTx as unknown as PrismaTransactionClient),
  );
}
