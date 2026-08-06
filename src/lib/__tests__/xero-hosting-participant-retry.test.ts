import { describe, expect, it } from "vitest";

import { HostingCoverageParticipantRetryError } from "@/lib/adult-member-hosting-queue-participants";
import { recordLinkedContactSubscriptionSyncError } from "@/lib/xero-membership-sync";

describe("linked-contact membership sync participant contention (#2597)", () => {
  it("rethrows participant contention instead of converting it to a successful warning", () => {
    const errors: Array<{ seasonYear: number; error: string }> = [];
    const retry = new HostingCoverageParticipantRetryError();

    expect(() =>
      recordLinkedContactSubscriptionSyncError(errors, 2026, retry),
    ).toThrow(retry);
    expect(errors).toEqual([]);
  });

  it("continues to aggregate ordinary per-season Xero failures", () => {
    const errors: Array<{ seasonYear: number; error: string }> = [];

    expect(
      recordLinkedContactSubscriptionSyncError(
        errors,
        2026,
        new Error("ordinary Xero failure"),
      ),
    ).toBe(false);
    expect(errors).toEqual([
      { seasonYear: 2026, error: "ordinary Xero failure" },
    ]);
  });
});
