import { describe, it, expect } from "vitest";
import {
  getParentEmailSourceId,
  buildParentLinks,
  matchParentLinkIdForNotification,
  resolveInheritedEmailSourceId,
} from "@/lib/member-parent-links";

describe("getParentEmailSourceId", () => {
  it("returns null for a missing parent", () => {
    expect(getParentEmailSourceId(null)).toBeNull();
    expect(getParentEmailSourceId(undefined)).toBeNull();
  });

  it("prefers the parent's own inheritEmailFromId when set", () => {
    expect(
      getParentEmailSourceId({ id: "p1", inheritEmailFromId: "grandparent-1" }),
    ).toBe("grandparent-1");
  });

  it("falls back to the parent id when it inherits from no one", () => {
    expect(getParentEmailSourceId({ id: "p1", inheritEmailFromId: null })).toBe("p1");
    expect(getParentEmailSourceId({ id: "p1" })).toBe("p1");
  });
});

/**
 * #2255 renamed this from `resolveParentNotificationSourceId` and narrowed what
 * it decides. It used to return the MAILBOX, computed one hop from the selected
 * parent. Under four generations the mailbox can be several hops up, which needs
 * database reads, so this now answers only "which linked parent did the admin
 * pick?" and the caller walks from there. Every selection-matching case below is
 * carried over unchanged — the three-way null / undefined / id contract is what
 * the callers branch on.
 */
describe("matchParentLinkIdForNotification", () => {
  const links = [
    { id: "parent-1", inheritEmailFromId: null },
    { id: "parent-2", inheritEmailFromId: "grandparent-9" },
  ];

  // The crux of the admin family-group approve flow: the "Use child's own email"
  // option sends an EMPTY STRING (the <option value=""> in the notification-parent
  // picker), which must resolve to null — i.e. no inheritance, the child keeps its
  // own email. Callers rely on this coercion (see admin-family-group-requests-service
  // and the reviewFamilyGroupRequestSchema `.or(z.literal(""))`), so lock it in.
  it("treats an empty string as 'no inheritance' (use own email → null)", () => {
    expect(matchParentLinkIdForNotification(links, "")).toBeNull();
  });

  it("treats whitespace-only, null, and undefined the same as empty (null)", () => {
    expect(matchParentLinkIdForNotification(links, "   ")).toBeNull();
    expect(matchParentLinkIdForNotification(links, null)).toBeNull();
    expect(matchParentLinkIdForNotification(links, undefined)).toBeNull();
  });

  it("matches a selected parent id to that parent", () => {
    expect(matchParentLinkIdForNotification(links, "parent-1")).toBe("parent-1");
    expect(matchParentLinkIdForNotification(links, "parent-2")).toBe("parent-2");
  });

  it("accepts a selection that names a parent's already-flattened source", () => {
    // The admin UI round-trips the MAILBOX for a parent who themselves inherits,
    // so the selection may be the grandparent's id rather than the parent's.
    expect(matchParentLinkIdForNotification(links, "grandparent-9")).toBe(
      "parent-2",
    );
  });

  it("returns undefined for a selection matching no linked parent", () => {
    expect(matchParentLinkIdForNotification(links, "stranger-1")).toBeUndefined();
  });

  it("trims a padded but valid selection before matching", () => {
    expect(matchParentLinkIdForNotification(links, "  parent-1  ")).toBe(
      "parent-1",
    );
  });
});

/**
 * #2255 (D9): the transitive resolution itself, exercised directly rather than
 * through a route. It has to be pinned here as well as at the route, because
 * two of its three callers — the unlink route and the family-group reviewer —
 * run no depth check beforehand, so this walk is the only thing that has to
 * cope with a family loop or an over-deep chain on those paths.
 */
describe("resolveInheritedEmailSourceId", () => {
  type Row = {
    id: string;
    email: string;
    ageTier: string;
    archivedAt: Date | null;
    inheritEmailFromId: string | null;
    parentMemberId: string | null;
    secondaryParentId: string | null;
  };

  function db(rows: Array<Partial<Row> & { id: string }>) {
    const byId = new Map<string, Row>(
      rows.map((row) => [
        row.id,
        {
          email: `${row.id}@example.org`,
          ageTier: "ADULT",
          archivedAt: null,
          inheritEmailFromId: null,
          parentMemberId: null,
          secondaryParentId: null,
          ...row,
        } as Row,
      ]),
    );
    let queries = 0;
    const client = {
      member: {
        async findMany({ where }: { where: { id: { in: string[] } } }) {
          queries += 1;
          return where.id.in
            .map((id) => byId.get(id))
            .filter((row): row is Row => Boolean(row));
        },
        // #2255: the walk re-reads a stored pointer's TARGET before trusting
        // it, so a pointer at an archived or anonymised member is not
        // propagated onward as though it were still a live mailbox.
        async findUnique({ where }: { where: { id: string } }) {
          queries += 1;
          return byId.get(where.id) ?? null;
        },
      },
      get queryCount() {
        return queries;
      },
    };
    return client as unknown as Parameters<typeof resolveInheritedEmailSourceId>[0] & {
      queryCount: number;
    };
  }

  const placeholder = "walk-in-1@no-email.invalid";

  it("uses the parent when the parent can receive mail", async () => {
    const result = await resolveInheritedEmailSourceId(db([{ id: "p" }]), "p");
    expect(result).toEqual({ sourceId: "p" });
  });

  it("short-circuits on the parent's own already-flattened source", async () => {
    // Stored inheritance is always terminal, so this hop needs no further walk —
    // and taking it is what keeps a non-login middle generation's children
    // pointed at the same mailbox as the middle generation itself.
    const result = await resolveInheritedEmailSourceId(
      db([{ id: "p", inheritEmailFromId: "gp" }, { id: "gp" }]),
      "p",
    );
    expect(result).toEqual({ sourceId: "gp" });
  });

  it("walks up past a parent whose only address is a placeholder", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([
        { id: "p", email: placeholder, parentMemberId: "gp" },
        { id: "gp" },
      ]),
      "p",
    );
    expect(result).toEqual({ sourceId: "gp" });
  });

  it("walks up past a non-adult and past an archived ancestor", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([
        { id: "p", email: placeholder, parentMemberId: "youth" },
        { id: "youth", ageTier: "YOUTH", parentMemberId: "archived" },
        { id: "archived", archivedAt: new Date("2026-01-01"), parentMemberId: "ggp" },
        { id: "ggp" },
      ]),
      "p",
    );
    expect(result).toEqual({ sourceId: "ggp" });
  });

  // #2282: THE young-parent case, and the load-bearing one for that issue. The
  // walk STARTS on a 16-year-old who is now recordable as a parent and who has a
  // perfectly real address of their own — the previous test walks past a
  // non-adult found part-way UP, which does not exercise level 0. Being the
  // club's contact of record is a responsibility function and stays adult-only,
  // so the child's mail must go to the grandparent instead.
  //
  // Mutation probe: delete `member.ageTier === "ADULT"` from
  // `isUsableEmailSource` and this test resolves to "young-parent" and fails.
  it("walks past a young PARENT with a real address, to the nearest adult", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([
        {
          id: "young-parent",
          ageTier: "YOUTH",
          email: "teen@example.org",
          parentMemberId: "gp",
        },
        { id: "gp" },
      ]),
      "young-parent",
    );
    expect(result).toEqual({ sourceId: "gp" });
  });

  // The other half of the same rule: a young parent with nobody adult above them
  // is NOT quietly promoted to the source. Nothing is returned, and the callers
  // turn that into the "no reachable mailbox" refusal rather than storing the
  // minor as the family's contact of record.
  it("returns nobody rather than falling back on the young parent", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([{ id: "young-parent", ageTier: "YOUTH", email: "teen@example.org" }]),
      "young-parent",
    );
    expect(result).toEqual({ sourceId: null });
  });

  it("prefers the nearer ancestor, and the primary edge within a level", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([
        {
          id: "p",
          email: placeholder,
          parentMemberId: "primary-gp",
          secondaryParentId: "secondary-gp",
        },
        { id: "primary-gp" },
        { id: "secondary-gp" },
      ]),
      "p",
    );
    expect(result.sourceId).toBe("primary-gp");
  });

  it("stops at the depth cap rather than walking a long chain", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([
        { id: "p", email: placeholder, parentMemberId: "a" },
        { id: "a", email: placeholder, parentMemberId: "b" },
        { id: "b", email: placeholder, parentMemberId: "c" },
        { id: "c", email: placeholder, parentMemberId: "far" },
        { id: "far" },
      ]),
      "p",
    );
    expect(result.sourceId).toBeNull();
  });

  it("visits each member once on a family loop instead of circling", async () => {
    // Terminating is not enough on its own to show the walk is cycle-SAFE: a
    // level bound alone would also terminate, after a round trip per level. The
    // query count is what distinguishes the two, so it is asserted.
    const client = db([
      { id: "p", email: placeholder, parentMemberId: "a" },
      { id: "a", email: placeholder, parentMemberId: "p" },
    ]);

    const result = await resolveInheritedEmailSourceId(client, "p");

    expect(result.sourceId).toBeNull();
    expect(client.queryCount).toBeLessThanOrEqual(3);
  });

  it("does not trust a stored pointer whose target can no longer receive mail", async () => {
    // A stored pointer is a snapshot of a past decision. The member it names
    // can have been archived or anonymised since, and following it blindly
    // would hand a dead mailbox to a NEW dependant and call it resolved.
    const result = await resolveInheritedEmailSourceId(
      db([
        { id: "p", email: placeholder, inheritEmailFromId: "gone", parentMemberId: "gp" },
        { id: "gone", archivedAt: new Date("2026-01-01") },
        { id: "gp" },
      ]),
      "p",
    );
    expect(result).toEqual({ sourceId: "gp" });
  });

  it("does not trust a stored pointer whose target now inherits (terminality)", async () => {
    // P->X was valid when written; X was later linked as a dependant and now
    // inherits from Y. Returning X would break the flat-terminal invariant every
    // one-hop reader depends on — and the two callers fail differently and both
    // badly: a validating writer 422s with "cannot chain through another
    // inherited member", naming a member the admin never chose, while the unlink
    // route has no validator and would simply store the chained pointer.
    const result = await resolveInheritedEmailSourceId(
      db([
        { id: "p", email: placeholder, inheritEmailFromId: "x", parentMemberId: "gp" },
        { id: "x", inheritEmailFromId: "y" },
        { id: "y" },
        { id: "gp" },
      ]),
      "p",
    );
    // Walks ON rather than returning the chaining X — to P's own parent, which
    // is the next candidate the walk would have considered anyway.
    expect(result).toEqual({ sourceId: "gp" });
  });

  it("treats a deletion-anonymised address as unreachable", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([
        { id: "p", email: "deleted-abc12345@deleted.invalid", parentMemberId: "gp" },
        { id: "gp" },
      ]),
      "p",
    );
    expect(result).toEqual({ sourceId: "gp" });
  });

  it("returns null when nobody in reach can receive mail", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([{ id: "p", email: placeholder }]),
      "p",
    );
    expect(result).toEqual({ sourceId: null });
  });
});

describe("buildParentLinks", () => {
  const base = {
    firstName: "A",
    lastName: "B",
    email: "a@b.test",
  };

  it("includes primary and distinct secondary parents", () => {
    const links = buildParentLinks({
      parent: { id: "p1", ...base },
      secondaryParent: { id: "p2", ...base },
    });
    expect(links.map((l) => l.id)).toEqual(["p1", "p2"]);
    expect(links.map((l) => l.parentLinkType)).toEqual(["PRIMARY", "SECONDARY"]);
  });

  it("drops a secondary parent that duplicates the primary", () => {
    const links = buildParentLinks({
      parent: { id: "p1", ...base },
      secondaryParent: { id: "p1", ...base },
    });
    expect(links.map((l) => l.id)).toEqual(["p1"]);
  });

  it("returns an empty list when there are no parents", () => {
    expect(buildParentLinks({})).toEqual([]);
  });
});
