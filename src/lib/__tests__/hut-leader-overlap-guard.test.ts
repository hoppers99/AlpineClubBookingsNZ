import { describe, expect, it, vi } from "vitest";

import { findHutLeaderOverlapRefusal } from "@/lib/hut-leader-overlap-guard";

/**
 * The one hut-leader overlap predicate, and the SCHOOL carve-out (#2887).
 *
 * Owner decision: teacher records must not block. Approving a school booking
 * creates one assignment per teacher, same dates and same lodge, deliberately
 * overlapping each other — and those rows used to refuse any later manual or
 * cron assignment for those nights while never being refused themselves.
 *
 * The direction that changed is only that one. Whether an existing assignment
 * blocks a TEACHER is unchanged: the school path runs no overlap read at all.
 */
function tx(rows: Array<Record<string, unknown>>) {
  const findMany = vi.fn(async () => rows);
  return {
    client: { hutLeaderAssignment: { findMany } } as unknown as Parameters<
      typeof findHutLeaderOverlapRefusal
    >[0],
    findMany,
  };
}

const WINDOW = {
  lodgeId: "lodge-1",
  startDate: new Date("2026-07-01T00:00:00.000Z"),
  endDate: new Date("2026-07-05T00:00:00.000Z"),
};

const CLASHING_ROW = {
  id: "other",
  startDate: new Date("2026-07-01T00:00:00.000Z"),
  endDate: new Date("2026-07-05T00:00:00.000Z"),
  member: { firstName: "Ada", lastName: "Lovelace" },
};

describe("findHutLeaderOverlapRefusal (#2887)", () => {
  it("refuses a clash with an ordinary assignment", async () => {
    const { client } = tx([CLASHING_ROW]);
    await expect(findHutLeaderOverlapRefusal(client, WINDOW)).resolves.toMatchObject({
      error: expect.stringContaining("Ada Lovelace"),
    });
  });

  it("excludes SCHOOL-sourced rows in the QUERY, so teachers never block", async () => {
    /*
      Asserted on the `where` rather than by handing the filter a teacher row:
      the exclusion happens in the database, so a test that returned one from a
      double would be testing the double. This pins the predicate that Prisma
      is actually asked for.
    */
    const { client, findMany } = tx([]);
    await expect(findHutLeaderOverlapRefusal(client, WINDOW)).resolves.toBeNull();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          member: { role: { not: "SCHOOL" } },
        }),
      }),
    );
  });

  it("still scopes to the lodge and still allows a one-day handover", async () => {
    const { client, findMany } = tx([
      {
        id: "handover",
        // Ends the day this one starts: exactly one day, which is the handover
        // the rule exists to permit.
        startDate: new Date("2026-06-28T00:00:00.000Z"),
        endDate: new Date("2026-07-01T00:00:00.000Z"),
        member: { firstName: "Grace", lastName: "Hopper" },
      },
    ]);
    await expect(findHutLeaderOverlapRefusal(client, WINDOW)).resolves.toBeNull();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lodgeId: expect.anything() }),
      }),
    );
  });

  it("excludes the row being edited when asked to", async () => {
    const { client, findMany } = tx([]);
    await findHutLeaderOverlapRefusal(client, {
      ...WINDOW,
      excludeAssignmentId: "a1",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "a1" } }),
      }),
    );
  });
});
