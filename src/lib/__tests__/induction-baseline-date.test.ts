import { afterEach, describe, expect, it, vi } from "vitest";
import { runInductionBaseline } from "@/lib/induction-baseline";

const BASE_OPTIONS = {
  actorMemberId: "admin-1",
  provenanceNote: "Committee minute 2024-07",
  databaseTarget: {
    host: "postgres.internal:5432",
    databaseName: "alpine_club",
  },
  fallbackClubName: "unused",
  fallbackClubNameSource: "primary" as const,
};

describe("trusted induction baseline date boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a date after today in New Zealand before opening a transaction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    const transaction = vi.fn();

    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        baselineDate: "2026-08-01",
        store: { $transaction: transaction } as never,
      }),
    ).rejects.toThrow(
      "The baseline date cannot be later than the current New Zealand date.",
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("allows the current New Zealand date to reach normal validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    const transaction = vi.fn(async () => {
      throw new Error("transaction reached");
    });

    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        baselineDate: "2026-07-31",
        store: { $transaction: transaction } as never,
      }),
    ).rejects.toThrow("transaction reached");
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
