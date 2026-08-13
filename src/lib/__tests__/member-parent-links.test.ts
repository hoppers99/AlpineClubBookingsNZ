import { describe, it, expect } from "vitest";
import {
  getParentEmailSourceId,
  buildMemberFacingParentLinks,
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
  // #2716 REWROTE THIS BLOCK. It used to describe a level-order WALK up the
  // family tree to the nearest ancestor who could receive mail — the tie-breaks,
  // the depth cap, the cycle guard, the re-read of a stored pointer's target.
  // None of that survives, because the owner narrowed inheritance to the direct
  // parent: an address that travels an arbitrary number of hops is
  // unpredictable to the person whose address it is.
  //
  // What the deleted tests asserted is not lost, it moved: every "walks past an
  // unusable generation" case is now a "resolves to NOBODY" case, and the
  // members those cases left unreachable are surfaced to an admin instead
  // (`unreachableMemberWhere`, covered in
  // member-email-inheritance-reconcile.test.ts).
  type Row = {
    id: string;
    email: string;
    ageTier: string;
    archivedAt: Date | null;
    inheritEmailFromId: string | null;
    inheritEmailChoiceId: string | null;
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
          inheritEmailChoiceId: null,
          parentMemberId: null,
          secondaryParentId: null,
          ...row,
        } as Row,
      ]),
    );
    let queries = 0;
    const client = {
      member: {
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

  it("reads exactly one row, whatever the family looks like above it", async () => {
    // Not a performance assertion: it is how this test pins that there is no
    // walk left to regress into. A second query would mean somebody had
    // reintroduced a hop.
    const client = db([
      { id: "p", email: placeholder, parentMemberId: "gp" },
      { id: "gp" },
    ]);
    await resolveInheritedEmailSourceId(client, "p");
    expect(client.queryCount).toBe(1);
  });

  it("resolves to nobody when the parent's only address is a placeholder", async () => {
    // The heart of the change. This used to answer "gp". The grandparent who
    // supplied an email for one grandchild does not thereby expect
    // notifications for a branch of the family they may have no involvement
    // with, so the dependant now inherits NOBODY and the club has to ask.
    const result = await resolveInheritedEmailSourceId(
      db([
        { id: "p", email: placeholder, parentMemberId: "gp" },
        { id: "gp" },
      ]),
      "p",
    );
    expect(result).toEqual({ sourceId: null });
  });

  it("resolves to nobody through a parent who is themselves inheriting", async () => {
    // Following the parent's own pointer would be transitivity wearing a
    // different hat — and the parent's `email` column is typically a stale copy
    // of the very mailbox that pointer names.
    const result = await resolveInheritedEmailSourceId(
      db([
        { id: "p", inheritEmailFromId: "gp", inheritEmailChoiceId: "gp" },
        { id: "gp" },
      ]),
      "p",
    );
    expect(result).toEqual({ sourceId: null });
  });

  it("resolves to nobody through a parent who has chosen a source but cannot reach it", async () => {
    // The post-#2716 shape: a live choice beside a NULL pointer, because the
    // chosen mailbox went away. Testing only the pointer would read this member
    // as a mailbox of their own and make the sweep order-dependent.
    const result = await resolveInheritedEmailSourceId(
      db([{ id: "p", inheritEmailChoiceId: "gp" }, { id: "gp" }]),
      "p",
    );
    expect(result).toEqual({ sourceId: null });
  });

  // #2282: being the club's contact of record is a responsibility function and
  // stays adult-only, even though parentage may now be recorded at any age.
  // Under #2716 the consequence is sharper than it was: the child's mail no
  // longer routes on up to the young parent's own parent, it goes nowhere.
  //
  // Mutation probe: delete `member.ageTier === "ADULT"` from
  // `isUsableEmailSource` and this test resolves to "young-parent" and fails.
  it("refuses a young parent with a real address, and does not look past them", async () => {
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
    expect(result).toEqual({ sourceId: null });
  });

  it("refuses an archived parent", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([{ id: "p", archivedAt: new Date("2026-01-01") }]),
      "p",
    );
    expect(result).toEqual({ sourceId: null });
  });

  it("treats a deletion-anonymised address as unreachable", async () => {
    const result = await resolveInheritedEmailSourceId(
      db([{ id: "p", email: "deleted-abc12345@deleted.invalid" }]),
      "p",
    );
    expect(result).toEqual({ sourceId: null });
  });

  it("returns nobody for a parent who does not exist", async () => {
    const result = await resolveInheritedEmailSourceId(db([]), "ghost");
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

  it("keeps the email — admin surfaces still see it (#2424)", () => {
    const links = buildParentLinks({ parent: { id: "p1", ...base } });
    expect(links[0].email).toBe("a@b.test");
  });
});

describe("buildMemberFacingParentLinks (#2424)", () => {
  const base = {
    firstName: "A",
    lastName: "B",
    email: "a@b.test",
  };

  /**
   * A parent row carrying EVERY field the selects produce, so the key-set
   * assertions below are testing the whitelist rather than an absent fixture.
   */
  const fullParent = {
    ...base,
    ageTier: "YOUTH",
    active: true,
    canLogin: false,
    inheritEmailFromId: "gp1",
  };

  /**
   * The EXACT key sets each branch may emit. Asserted as sorted key arrays
   * rather than as "does not have `email`", because a builder that stopped
   * whitelisting — `Object.assign(visible, link)` in the sharing branch, say —
   * satisfies every field-by-field assertion while leaking the parent's whole
   * row, `familyGroupMemberships` included.
   */
  const IN_GROUP_KEYS = [
    "active",
    "ageTier",
    "canLogin",
    "email",
    "firstName",
    "id",
    "inheritEmailFromId",
    "lastName",
    "parentLinkType",
  ];
  /**
   * Out of group there is no email AND no status: `ageTier`, `active` and
   * `canLogin` are facts about a person the viewer has no family relationship
   * with, and `ageTier` says whether a named stranger is a child. No
   * member-facing client reads any of them.
   */
  const OUT_OF_GROUP_KEYS = [
    "firstName",
    "id",
    "inheritEmailFromId",
    "lastName",
    "parentLinkType",
  ];

  it("returns the email when the parent shares a group with the viewer", () => {
    const links = buildMemberFacingParentLinks(
      {
        parent: {
          id: "p1",
          ...base,
          familyGroupMemberships: [{ familyGroupId: "g1" }],
        },
      },
      ["g1"],
    );
    expect(links[0].email).toBe("a@b.test");
  });

  it("emits EXACTLY the whitelist for a parent in the viewer's group", () => {
    const links = buildMemberFacingParentLinks(
      {
        parent: {
          id: "p1",
          ...fullParent,
          familyGroupMemberships: [{ familyGroupId: "g1" }],
        },
      },
      ["g1"],
    );
    expect(Object.keys(links[0]).sort()).toEqual(IN_GROUP_KEYS);
    expect(links[0]).not.toHaveProperty("familyGroupMemberships");
  });

  it("emits EXACTLY the whitelist for a parent outside the viewer's groups", () => {
    const links = buildMemberFacingParentLinks(
      {
        parent: {
          id: "p1",
          ...fullParent,
          familyGroupMemberships: [{ familyGroupId: "g-other" }],
        },
      },
      ["g1"],
    );
    expect(Object.keys(links[0]).sort()).toEqual(OUT_OF_GROUP_KEYS);
    expect(links[0]).not.toHaveProperty("familyGroupMemberships");
  });

  it("withholds a stranger's status fields, not just their address", () => {
    // #2282 records parentage at any age, so `ageTier` on an out-of-group
    // parent would tell the viewer that a named stranger is a YOUTH.
    const links = buildMemberFacingParentLinks(
      {
        parent: {
          id: "p1",
          ...fullParent,
          familyGroupMemberships: [{ familyGroupId: "g-other" }],
        },
      },
      ["g1"],
    );
    expect(links[0]).not.toHaveProperty("ageTier");
    expect(links[0]).not.toHaveProperty("active");
    expect(links[0]).not.toHaveProperty("canLogin");
    // The notifications marker still works: it matches on this id.
    expect(links[0].inheritEmailFromId).toBe("gp1");
  });

  it("omits the email when no group is shared, keeping name and link type", () => {
    const links = buildMemberFacingParentLinks(
      {
        parent: {
          id: "p1",
          ...base,
          familyGroupMemberships: [{ familyGroupId: "g-other" }],
        },
      },
      ["g1"],
    );
    expect(links[0]).toEqual({
      id: "p1",
      firstName: "A",
      lastName: "B",
      parentLinkType: "PRIMARY",
    });
    expect(links[0]).not.toHaveProperty("email");
  });

  it("omits the email for a parent in no group at all", () => {
    const links = buildMemberFacingParentLinks(
      { parent: { id: "p1", ...base, familyGroupMemberships: [] } },
      ["g1"],
    );
    expect(links[0]).not.toHaveProperty("email");
  });

  it("omits the email when the viewer belongs to no group", () => {
    const links = buildMemberFacingParentLinks(
      {
        parent: {
          id: "p1",
          ...base,
          familyGroupMemberships: [{ familyGroupId: "g1" }],
        },
      },
      [],
    );
    expect(links[0]).not.toHaveProperty("email");
  });

  it("carries the optional fields through for a parent in the group", () => {
    const links = buildMemberFacingParentLinks(
      {
        parent: {
          id: "p1",
          ...base,
          ageTier: "YOUTH",
          active: true,
          canLogin: false,
          inheritEmailFromId: "gp1",
          familyGroupMemberships: [{ familyGroupId: "g1" }],
        },
      },
      ["g1"],
    );
    expect(links[0]).toMatchObject({
      ageTier: "YOUTH",
      active: true,
      canLogin: false,
      inheritEmailFromId: "gp1",
    });
  });

  it("is a whitelist: a field the query adds later cannot leak through", () => {
    const links = buildMemberFacingParentLinks(
      {
        parent: {
          id: "p1",
          ...base,
          familyGroupMemberships: [{ familyGroupId: "g-other" }],
          // A future select could add contact fields; the builder copies only
          // the fields it names, so this never reaches the payload.
          phoneNumber: "0211234567",
        } as Parameters<typeof buildMemberFacingParentLinks>[0]["parent"],
      },
      ["g1"],
    );
    expect(links[0]).not.toHaveProperty("phoneNumber");
    expect(links[0]).not.toHaveProperty("familyGroupMemberships");
  });

  it("decides per parent, not per member", () => {
    const links = buildMemberFacingParentLinks(
      {
        parent: {
          id: "p1",
          ...base,
          email: "in@b.test",
          familyGroupMemberships: [{ familyGroupId: "g1" }],
        },
        secondaryParent: {
          id: "p2",
          ...base,
          email: "out@b.test",
          familyGroupMemberships: [{ familyGroupId: "g-other" }],
        },
      },
      ["g1"],
    );
    expect(links[0].email).toBe("in@b.test");
    expect(links[1]).not.toHaveProperty("email");
  });
});
