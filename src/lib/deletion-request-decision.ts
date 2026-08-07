import type { Prisma } from "@prisma/client";

type DeletionRequestDecisionDb = Pick<
  Prisma.TransactionClient,
  "deletionRequest"
>;

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
 * The sole approve/reject winner protocol. PostgreSQL serializes contenders on
 * the DeletionRequest row; exactly one PENDING transition may claim it. When
 * called in the approval anonymisation transaction, any later failure rolls
 * this claim back with every privacy mutation.
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
    where: { id: input.id, status: "PENDING" },
    data: {
      status: input.decision,
      adminNote: input.adminNote,
      reviewedBy: input.reviewedBy,
      reviewedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    throw new DeletionRequestDecisionLostError();
  }
}
