import { describe, expect, it } from "vitest";

import {
  approveAndExecuteModificationExceptionRequest,
  approveAndExecuteNewBookingExceptionRequest,
  EXECUTION_APPROVED_STATUS,
  ExceptionExecutionNotImplementedError,
  reserveExceptionRequestProposalCapacity,
} from "@/lib/booking-exception-execution";

// The #2525 seam. #2524 must NOT implement approval / execution / reservation.
// These stubs pin the forward contract: every one rejects with the typed
// not-implemented error, and none is reachable from the request-creation path.
describe("booking exception execution seam (#2525 boundary)", () => {
  it("reserveExceptionRequestProposalCapacity is unimplemented", async () => {
    await expect(
      reserveExceptionRequestProposalCapacity({ requestId: "r", source: "NEW_BOOKING" }),
    ).rejects.toBeInstanceOf(ExceptionExecutionNotImplementedError);
  });

  it("approveAndExecuteNewBookingExceptionRequest is unimplemented", async () => {
    await expect(
      approveAndExecuteNewBookingExceptionRequest({
        requestId: "r",
        reviewedByMemberId: "a",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ issue: "#2525" });
  });

  it("approveAndExecuteModificationExceptionRequest is unimplemented", async () => {
    await expect(
      approveAndExecuteModificationExceptionRequest({
        requestId: "r",
        reviewedByMemberId: "a",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ExceptionExecutionNotImplementedError);
  });

  it("names APPROVED as the execution outcome", () => {
    expect(EXECUTION_APPROVED_STATUS).toBe("APPROVED");
  });
});
