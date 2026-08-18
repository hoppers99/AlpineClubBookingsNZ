import { describe, expect, it, vi } from "vitest";

import { findHutLeaderOverlapRefusal } from "@/lib/hut-leader-overlap-guard";

/**
 * The one hut-leader overlap predicate, and the SCHOOL carve-out (#2887).
 *
 * Consolidating four hand-copied versions of this rule into one predicate is
 * what this file guards: the >1-day comparison, the lodge scope and the
 * exclude-self behaviour now have a single home, so they cannot drift between
 * the POST, the PUT and the cron.
 *
 * School-teacher rows are NOT excluded here — see #2926.
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

  it("is role-blind: every assignment is a conflict, whatever created it (#2926)", async () => {
    /*
      Pins TODAY's behaviour so that changing it is deliberate.

      School-teacher rows block, because the predicate filters on dates and
      lodge only. Excluding them was attempted in this PR and reverted, and
      nothing else here would have noticed it being put back — so this asserts
      the absence of a member filter directly. #2926 must update this case, and
      when it does it has to say WHICH rows it covers: `Member.role = "SCHOOL"`
      is set for the school CONTACT member as well as for teachers.
    */
    const { client, findMany } = tx([]);
    await findHutLeaderOverlapRefusal(client, WINDOW);
    const where = (
      findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(Object.keys(where).sort()).toEqual(["endDate", "lodgeId", "startDate"]);
    expect(where).not.toHaveProperty("member");
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
