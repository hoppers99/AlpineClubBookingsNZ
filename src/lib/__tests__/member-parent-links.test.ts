import { describe, it, expect } from "vitest";
import {
  getParentEmailSourceId,
  buildParentLinks,
  matchParentLinkIdForNotification,
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
