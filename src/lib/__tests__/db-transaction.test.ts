import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn("OWN_TX")),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.$transaction },
}));

import { withOptionalTransaction } from "@/lib/db-transaction";

describe("withOptionalTransaction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens its OWN transaction when no caller tx is supplied", async () => {
    const fn = vi.fn(async (tx: unknown) => `ran-with:${tx}`);
    const result = await withOptionalTransaction(undefined, fn as never);
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    expect(result).toBe("ran-with:OWN_TX");
  });

  it("runs on the CALLER's transaction and opens none of its own", async () => {
    const fn = vi.fn(async (tx: unknown) => `ran-with:${tx}`);
    const result = await withOptionalTransaction("CALLER_TX" as never, fn as never);
    expect(mocks.$transaction).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledWith("CALLER_TX");
    expect(result).toBe("ran-with:CALLER_TX");
  });

  it("propagates a callback error (rolls back the caller's tx via rethrow)", async () => {
    const boom = new Error("boom");
    await expect(
      withOptionalTransaction("CALLER_TX" as never, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });
});

describe("policy-exception reservation delegate (production-presence contract)", () => {
  it("the generated schema exposes the PolicyExceptionReservationNight model", () => {
    // The capacity engines pass `tx ?? prisma`, both of which always expose this
    // delegate because it is generated from the schema — so the test-double
    // tolerance in findActivePolicyExceptionReservationNights can never mask a
    // missing delegate in production. This freezes that the model exists.
    const model = Prisma.dmmf.datamodel.models.find(
      (m) => m.name === "PolicyExceptionReservationNight",
    );
    expect(model, "PolicyExceptionReservationNight missing from schema").toBeDefined();
    const fieldNames = new Set(model!.fields.map((f) => f.name));
    for (const required of ["changeRequestId", "lodgeId", "night", "beds"]) {
      expect(fieldNames.has(required), `field ${required}`).toBe(true);
    }
  });
});
