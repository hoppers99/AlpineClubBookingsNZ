import { describe, expect, it, vi } from "vitest";

import {
  claimDeletionRequestDecision,
  DELETION_REQUEST_ALREADY_REVIEWED_CODE,
} from "@/lib/deletion-request-decision";

describe("deletion request exact decision claim", () => {
  it.each(["APPROVED", "REJECTED"] as const)(
    "claims PENDING as %s with one guarded mutation",
    async (decision) => {
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      await expect(
        claimDeletionRequestDecision(
          { deletionRequest: { updateMany } as never },
          {
            id: "request-1",
            decision,
            reviewedBy: "admin-1",
            adminNote: null,
          },
        ),
      ).resolves.toBeUndefined();
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: "request-1", status: "PENDING" },
        data: expect.objectContaining({
          status: decision,
          reviewedBy: "admin-1",
        }),
      });
    },
  );

  it("reports a lost decision without a second mutation", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "REJECTED",
          reviewedBy: "admin-2",
          adminNote: "late",
        },
      ),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_ALREADY_REVIEWED_CODE,
      statusCode: 409,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
