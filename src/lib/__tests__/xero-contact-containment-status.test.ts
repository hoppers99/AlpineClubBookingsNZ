import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Xero-containment summary an operator reads (ENV-SAFETY 3, #3036; epic
 * #2986; INV-CONFIG-005).
 *
 * WHY THIS NUMBER EXISTS. `/admin/environment` already says which installation
 * this is. What the role cannot say is whether this copy has been pointed at the
 * club's REAL Xero organisation — and if it has, containment has rewritten email
 * addresses on real accounting records. That is a destructive edit made for a
 * good reason, and the person who finds it needs to know how many contacts it
 * touched. So two numbers, meaning different things, and never summed.
 */

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  count: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSandboxContactContainment: {
      aggregate: mocks.aggregate,
      count: mocks.count,
    },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { readXeroContactContainment } from "@/lib/xero-contact-containment-status";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readXeroContactContainment", () => {
  it("reports how many contacts are contained and how many held a real address", async () => {
    mocks.aggregate.mockResolvedValue({
      _count: { _all: 214 },
      _max: { updatedAt: new Date("2026-06-25T02:00:00.000Z") },
    });
    mocks.count.mockResolvedValue(198);

    expect(await readXeroContactContainment()).toEqual({
      available: true,
      containedContacts: 214,
      rewrittenContacts: 198,
      mostRecentAt: "2026-06-25T02:00:00.000Z",
    });
  });

  it("counts the rewritten ones as a SUBSET, keyed on the flag", async () => {
    // Not a second population: the same table, narrowed to the contacts that
    // were holding something deliverable when this installation overwrote it.
    mocks.aggregate.mockResolvedValue({
      _count: { _all: 3 },
      _max: { updatedAt: new Date("2026-06-01T00:00:00.000Z") },
    });
    mocks.count.mockResolvedValue(0);

    const summary = await readXeroContactContainment();
    expect(summary).toMatchObject({
      containedContacts: 3,
      rewrittenContacts: 0,
    });
    expect(mocks.count).toHaveBeenCalledWith({ where: { rewroteAddress: true } });
  });

  it("says null for the most recent instant when nothing has been contained", async () => {
    mocks.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _max: { updatedAt: null },
    });
    mocks.count.mockResolvedValue(0);

    expect(await readXeroContactContainment()).toEqual({
      available: true,
      containedContacts: 0,
      rewrittenContacts: 0,
      mostRecentAt: null,
    });
  });

  it("answers UNAVAILABLE rather than zero when the table cannot be read", async () => {
    /*
      The distinction is the point. "Nothing has been contained" says this copy
      has not touched the club's accounting; "we could not count" says nobody
      knows. On a copy that has been pointed at the real Xero organisation those
      are opposite answers, and a fabricated zero is the reassuring one.
    */
    mocks.aggregate.mockRejectedValue(new Error("relation does not exist"));
    mocks.count.mockRejectedValue(new Error("relation does not exist"));

    expect(await readXeroContactContainment()).toEqual({ available: false });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = mocks.logger.error.mock.calls[0];
    expect(message).toContain("prisma migrate deploy");
    // The Prisma error's MESSAGE and nothing else: a Prisma error can carry the
    // client's configuration on adjacent fields, and DATABASE_URL holds the
    // database password.
    expect(payload.err).toEqual({ message: "relation does not exist" });
    expect(Object.keys(payload).sort()).toEqual(["err", "scope"]);
  });

  it("fails soft, so an admin page renders rather than 500ing", async () => {
    mocks.aggregate.mockRejectedValue(new Error("boom"));
    mocks.count.mockRejectedValue(new Error("boom"));
    await expect(readXeroContactContainment()).resolves.toEqual({
      available: false,
    });
  });
});
