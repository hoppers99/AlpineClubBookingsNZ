import type { DeletionRequestStatus, Prisma } from "@prisma/client";

type DeletionRequestDecisionDb = Pick<
  Prisma.TransactionClient,
  "deletionRequest"
>;

/**
 * The statuses of a self-service deletion request that is still open: awaiting
 * a decision, or mid-approval with cleanup already committed. Every "is there
 * an outstanding request?" read — admin queue, pending counts, dashboard,
 * member re-request guard, merge blocker — must use this, because a request
 * that has begun approval is emphatically not resolved: it has already
 * cancelled bookings and still owes the member its anonymisation.
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

/**
 * Durably owns approval before any separately committed booking cancellation.
 * A later approval request may resume the existing claim, while rejection and
 * final approval remain mutually exclusive guarded transitions.
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
 * Approval can become final only from its durable APPROVAL_IN_PROGRESS claim,
 * inside the anonymisation transaction, so a later failure rolls finalisation
 * back without reopening the decision to rejection.
 */
export async function claimDeletionRequestDecision(
  db: DeletionRequestDecisionDb,
  input: {
    id: string;
    decision: "APPROVED" | "REJECTED";
    reviewedBy: string;
    adminNote: string | null;
  },
): Promise<void> {
  const claimed = await db.deletionRequest.updateMany({
    where: {
      id: input.id,
      status:
        input.decision === "APPROVED" ? "APPROVAL_IN_PROGRESS" : "PENDING",
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
