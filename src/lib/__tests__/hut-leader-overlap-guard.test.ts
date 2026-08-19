import { describe, expect, it, vi } from "vitest";

import { findHutLeaderOverlapRefusal } from "@/lib/hut-leader-overlap-guard";

/**
 * The one hut-leader overlap predicate, and the SCHOOL carve-out (#2887, #2926).
 *
 * Consolidating four hand-copied versions of this rule into one predicate is
 * what this file guards: the >1-day comparison, the lodge scope and the
 * exclude-self behaviour now have a single home, so they cannot drift between
 * the POST, the PUT and the cron.
 *
 * School-teacher rows ARE excluded now (#2926), on the row's own
 * `source` provenance. Behaviour on real rows — including the reclassification
 * case, which is the whole reason the first attempt was reverted — is proved
 * against a real PostgreSQL in `hut-leader-teacher-exclusion.realdb.test.ts`.
 * What THIS file can prove is the shape of the query, and that is worth pinning
 * separately: the failure mode being guarded against is a filter that reads
 * correctly and whose meaning an admin can move.
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

  it("excludes school-created rows on the ROW's provenance, never on the member (#2926)", async () => {
    /*
      This is the tripwire, and it is deliberately kept rather than relaxed.

      It used to assert the predicate had NO member-side filter at all, because
      school-teacher rows still blocked. #2926 changed WHICH rows are covered —
      the ones the school-approval path CREATED — and did not change what the
      predicate is allowed to ask about. The half that matters is unchanged and
      is still asserted below: the query names no member, no role and no access
      role. A filter derived from the member is exactly what was shipped and
      reverted once, and nothing else in this file would notice it coming back.

      WHICH ROWS THIS COVERS, stated because the previous version of this test
      demanded it be stated: rows whose `source` is `SCHOOL_BOOKING`, i.e. the
      one-per-teacher assignments `school-booking-request.ts` creates when a
      school request is approved. NOT "rows belonging to a member whose role is
      SCHOOL" — that set also contains the school CONTACT member, and it moves
      whenever an admin edits a member.
    */
    const { client, findMany } = tx([]);
    await findHutLeaderOverlapRefusal(client, WINDOW);
    const where = (
      findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;

    expect(Object.keys(where).sort()).toEqual([
      "endDate",
      "lodgeId",
      "source",
      "startDate",
    ]);
    expect(where.source).toEqual({ not: "SCHOOL_BOOKING" });

    // The carve-out is a property of the row. Nothing about the member may
    // appear anywhere in this query, at any depth: `Member.role` is derived
    // from the access roles and both are admin-writable, so any of these names
    // in the predicate means a membership edit can move a live assignment out
    // of the overlap check.
    expect(where).not.toHaveProperty("member");
    const serialised = JSON.stringify(where);
    for (const forbidden of ["member", "role", "accessRoles", "canLogin"]) {
      expect(
        serialised,
        `the overlap predicate derives the teacher carve-out from "${forbidden}", which an admin can edit`,
      ).not.toContain(forbidden);
    }
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
