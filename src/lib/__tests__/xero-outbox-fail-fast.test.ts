import { beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// F4 (#1354): the outbox processor must mark an operation FAILED for EVERY
// queue type when its handler throws — not only the two membership-cancellation
// types. An operation erroring before its handler overwrote requestPayload
// previously stayed RUNNING; after an operator stale-reset the retry stack
// could not parse the queued payload shape — a permanent dead-end.
// -----------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  operationFindMany: vi.fn(),
  operationUpdateMany: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  createXeroCreditNote: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findMany: mocks.operationFindMany,
      // The single-flight claim (PENDING -> RUNNING) succeeds.
      updateMany: mocks.operationUpdateMany,
    },
  },
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});

vi.mock("@/lib/xero-credit-notes", () => ({
  createXeroCreditNote: mocks.createXeroCreditNote,
  createUnappliedXeroCreditNote: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  XeroDailyLimitError,
  XeroTransientOutageError,
} from "@/lib/xero-api-client";
import { processQueuedXeroOutboxOperations } from "@/lib/xero-operation-outbox";

/** One queued refund-credit-note row, the same shape for every case below. */
function queueOneRefundOperation() {
  mocks.operationFindMany.mockResolvedValue([
    {
      id: "op_refund_1",
      localModel: "Payment",
      localId: "pay_1",
      requestPayload: {
        queueType: "REFUND_CREDIT_NOTE",
        refundAmountCents: 3000,
        watermarkCents: 8000,
      },
    },
  ]);
}

describe("outbox processor fail-fast for all queue types (#1354)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("marks a refund-credit-note operation FAILED when its handler throws before the payload overwrite", async () => {
    queueOneRefundOperation();
    // Token refresh / contact resolution / account mapping failures all
    // surface as a thrown error from the handler, BEFORE requestPayload is
    // overwritten with the Xero request shape.
    mocks.createXeroCreditNote.mockRejectedValue(
      new Error("Xero token refresh failed")
    );

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ found: 1, failed: 1, succeeded: 0 });
    // Pre-#1354 this operation stayed RUNNING (only the two
    // membership-cancellation types were failed); now it is replayable.
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_refund_1",
      expect.objectContaining({ message: "Xero token refresh failed" })
    );
  });

  // #2423 review F2. Fail-fast is right for an operation that was ATTEMPTED and
  // failed. It is wrong for one a process-global cooldown refused before any
  // HTTP: the first failing operation of a batch arms the breaker, and the rest
  // of that batch would be marked terminal FAILED without ever reaching Xero —
  // and nothing auto-recovers a FAILED row (the retry scanner only processes
  // operator-created REQUEUE rows), so ten members' invoices sit unsent until an
  // admin presses Requeue on each. Nothing was sent, so the row simply goes back
  // to PENDING for the next cron.
  describe.each([
    ["the transient-outage breaker", () => new XeroTransientOutageError(120)],
    ["the daily-limit gate", () => new XeroDailyLimitError(86_400)],
  ])("un-attempted refusal by %s", (_label, makeError) => {
    it("returns the operation to PENDING instead of failing it", async () => {
      queueOneRefundOperation();
      mocks.createXeroCreditNote.mockRejectedValue(makeError());

      const result = await processQueuedXeroOutboxOperations({ limit: 1 });

      expect(result).toMatchObject({
        found: 1,
        processed: 1,
        succeeded: 0,
        failed: 0,
        skipped: 1,
      });
      expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();

      // Call 1 is the claim (PENDING -> RUNNING); call 2 hands it back,
      // un-started, so the next scan re-drives it exactly as if it had never
      // been picked up.
      expect(mocks.operationUpdateMany).toHaveBeenCalledTimes(2);
      expect(mocks.operationUpdateMany).toHaveBeenLastCalledWith({
        where: { id: "op_refund_1", status: "RUNNING" },
        data: {
          status: "PENDING",
          startedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    });
  });

  // The boundary: only the pre-HTTP refusals change class. A 429 that Xero
  // itself returned (or any other error escaping the handler) was a real
  // attempt, so it keeps the replayable FAILED path exactly as before.
  it("still fails an operation that Xero itself rejected", async () => {
    queueOneRefundOperation();
    mocks.createXeroCreditNote.mockRejectedValue(
      Object.assign(new Error("Xero rate limit hit"), {
        response: { statusCode: 429 },
      })
    );

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ found: 1, failed: 1, skipped: 0 });
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_refund_1",
      expect.objectContaining({ message: "Xero rate limit hit" })
    );
    // Only the claim wrote to the row; nothing returned it to PENDING.
    expect(mocks.operationUpdateMany).toHaveBeenCalledTimes(1);
  });
});
