import type { DeletionRequestStatus, Prisma } from "@prisma/client";

type DeletionRequestDecisionDb = Pick<
  Prisma.TransactionClient,
  "deletionRequest"
>;

/**
 * The statuses of a self-service deletion request that is still open: awaiting
 * a decision, or mid-approval. Every "is there an outstanding request?" read —
 * admin queue, pending counts, dashboard, member re-request guard, merge
 * blocker — must use this, because a request that has begun approval is
 * emphatically not resolved: it still owes the member their anonymisation, and
 * it may already have cancelled future bookings.
 *
 * Deliberately a mutable array: Prisma's generated `in` filter rejects a
 * `readonly` tuple.
 */
export const OPEN_DELETION_REQUEST_STATUSES: DeletionRequestStatus[] = [
  "PENDING",
  "APPROVAL_IN_PROGRESS",
];

export const DELETION_REQUEST_ALREADY_REVIEWED_CODE =
  "DELETION_REQUEST_ALREADY_REVIEWED";
export const DELETION_REQUEST_ALREADY_REVIEWED_MESSAGE =
  "This request has already been reviewed.";

export class DeletionRequestDecisionLostError extends Error {
  readonly code = DELETION_REQUEST_ALREADY_REVIEWED_CODE;
  readonly statusCode = 409;

  constructor() {
    super(DELETION_REQUEST_ALREADY_REVIEWED_MESSAGE);
    this.name = "DeletionRequestDecisionLostError";
  }
}

export const DELETION_REQUEST_CLAIM_NOT_HELD_CODE =
  "DELETION_REQUEST_CLAIM_NOT_HELD";
export const DELETION_REQUEST_CLAIM_NOT_HELD_MESSAGE =
  "This deletion request is no longer mid-approval, so there is no approval claim to release. Reload the deletion queue to see its current state.";

/**
 * Raised when a release loses the race to a finalisation that was already
 * committing (or to another release). See
 * {@link releaseDeletionRequestApprovalClaim}.
 */
export class DeletionRequestClaimNotHeldError extends Error {
  readonly code = DELETION_REQUEST_CLAIM_NOT_HELD_CODE;
  readonly statusCode = 409;

  constructor() {
    super(DELETION_REQUEST_CLAIM_NOT_HELD_MESSAGE);
    this.name = "DeletionRequestClaimNotHeldError";
  }
}

/**
 * The status an approval finalises FROM (#2627).
 *
 * `APPROVAL_IN_PROGRESS` when the approval took the durable claim because it
 * had irreversible cleanup to protect; `PENDING` when it had none, so nothing
 * was consumed and an ordinary rejection could still have won right up to the
 * moment the anonymisation transaction committed.
 */
export type DeletionRequestApprovalOrigin = "PENDING" | "APPROVAL_IN_PROGRESS";

/**
 * Durably owns approval before any separately committed booking cancellation.
 * A later approval request may resume the existing claim, while rejection and
 * final approval remain mutually exclusive guarded transitions.
 *
 * #2627: the caller takes this ONLY when the approval genuinely has something
 * irreversible to protect (future bookings to cancel), or when it is resuming a
 * claim that already exists. An approval with nothing to cancel commits
 * everything it does in one transaction, so claiming would burn the ability to
 * reject in exchange for nothing.
 */
export async function claimDeletionRequestApproval(
  db: DeletionRequestDecisionDb,
  input: {
    id: string;
    reviewedBy: string;
    adminNote: string | null;
  },
): Promise<"CLAIMED" | "RESUMED"> {
  const claimed = await db.deletionRequest.updateMany({
    where: { id: input.id, status: "PENDING" },
    data: {
      status: "APPROVAL_IN_PROGRESS",
      adminNote: input.adminNote,
      reviewedBy: input.reviewedBy,
      reviewedAt: null,
    },
  });
  if (claimed.count === 1) return "CLAIMED";

  const current = await db.deletionRequest.findUnique({
    where: { id: input.id },
    select: { status: true },
  });
  if (current?.status === "APPROVAL_IN_PROGRESS") return "RESUMED";
  throw new DeletionRequestDecisionLostError();
}

/**
 * The final decision protocol. Rejection owns a still-PENDING request directly.
 *
 * Approval becomes final from the status its caller declares in
 * `approvalFrom` — its durable `APPROVAL_IN_PROGRESS` claim when it had
 * irreversible cleanup to protect, otherwise `PENDING`. Either way the
 * transition is a single guarded mutation inside the anonymisation transaction,
 * so a later failure rolls finalisation back to exactly the state it started
 * from and sends no receipt.
 *
 * The claimed variant is what makes a rejection unable to overtake committed
 * booking cancellations. The `PENDING` variant is only reachable when there
 * were none: an approval and a rejection then race for the same guarded
 * transition, exactly one wins, and the loser is told the request was already
 * reviewed — with nothing destructive having happened either way.
 */
export async function claimDeletionRequestDecision(
  db: DeletionRequestDecisionDb,
  input: {
    id: string;
    decision: "APPROVED" | "REJECTED";
    reviewedBy: string;
    adminNote: string | null;
    approvalFrom?: DeletionRequestApprovalOrigin;
  },
): Promise<void> {
  const claimed = await db.deletionRequest.updateMany({
    where: {
      id: input.id,
      status:
        input.decision === "APPROVED"
          ? (input.approvalFrom ?? "APPROVAL_IN_PROGRESS")
          : "PENDING",
    },
    data:
      input.decision === "APPROVED"
        ? { status: "APPROVED", reviewedAt: new Date() }
        : {
            status: "REJECTED",
            adminNote: input.adminNote,
            reviewedBy: input.reviewedBy,
            reviewedAt: new Date(),
          },
  });
  if (claimed.count !== 1) {
    throw new DeletionRequestDecisionLostError();
  }
}

/**
 * The way OUT of `APPROVAL_IN_PROGRESS` without anonymising anybody (#2627).
 *
 * Before this existed the claim was a one-way door: the only exit was a
 * successful anonymisation. A transient failure resumed fine, but a permanent
 * blocker wedged the request forever — and while wedged the member could not
 * lodge a new deletion request and their duplicate could not be merged, because
 * every "is there an outstanding request?" reader treats the state as open.
 *
 * It returns the request to `PENDING` rather than straight to `REJECTED` so the
 * decision itself is still made through the ordinary reject path, with its
 * guard, its audit entry, and its notify choice. `PENDING -> REJECTED` then
 * closes the loop.
 *
 * How this cannot race a finalisation that is already committing: the release is
 * the same guarded `updateMany` protocol as every other transition on this row.
 * A finalisation holds this exact row's write lock from its own guarded update
 * until its anonymisation transaction commits or rolls back, so a release that
 * arrives mid-commit blocks on that lock and only then re-evaluates its
 * `status: APPROVAL_IN_PROGRESS` predicate against the committed row — matching
 * zero rows and refusing with {@link DeletionRequestClaimNotHeldError} if the
 * approval won. If the release commits first, the finalisation's own guarded
 * update matches zero rows, raises
 * {@link DeletionRequestDecisionLostError}, and its whole anonymisation
 * transaction rolls back: no anonymisation, no approval receipt. There is no
 * interleaving in which both succeed.
 */
export async function releaseDeletionRequestApprovalClaim(
  db: DeletionRequestDecisionDb,
  input: {
    id: string;
    adminNote: string;
  },
): Promise<void> {
  const released = await db.deletionRequest.updateMany({
    where: { id: input.id, status: "APPROVAL_IN_PROGRESS" },
    data: {
      status: "PENDING",
      adminNote: input.adminNote,
      // Back to genuinely undecided: the claim's attribution described an
      // approval that is being abandoned, and a PENDING request has no
      // reviewer. Who released it, and who had held the claim, are recorded in
      // the audit trail instead.
      reviewedBy: null,
      reviewedAt: null,
    },
  });
  if (released.count !== 1) {
    throw new DeletionRequestClaimNotHeldError();
  }
}
