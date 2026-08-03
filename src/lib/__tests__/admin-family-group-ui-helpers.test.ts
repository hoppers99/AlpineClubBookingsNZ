import { afterEach, describe, expect, it } from "vitest";
import {
  buildInitialRequestNotificationParents,
  buildInitialRequestSelections,
  buildSharedEmailClusters,
  formatFamilyGroupDate,
  getFamilyGroupRequestSummary,
  getFamilyGroupRequestTypeLabel,
  mapFamilyGroupRequestSearchResults,
  mergeFamilyGroupRequestCandidates,
  type FamilyGroupMemberRow,
  type FamilyGroupRequest,
} from "@/lib/admin-family-group-ui-helpers";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

const baseRequest: FamilyGroupRequest = {
  id: "request-1",
  type: "CHILD_REQUEST",
  createdAt: "2026-05-01T00:00:00.000Z",
  requester: {
    id: "parent-1",
    firstName: "Ada",
    lastName: "Parent",
    email: "ada@example.com",
  },
  familyGroup: {
    id: "group-1",
    name: "Parent Family",
    members: [
      {
        id: "parent-1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ada@example.com",
        ageTier: "ADULT",
      },
    ],
  },
  childFirstName: "Bea",
  childLastName: "Child",
  childDateOfBirth: "2018-01-01",
  matchingMembers: [
    {
      id: "child-1",
      firstName: "Bea",
      lastName: "Child",
      email: "ada@example.com",
      ageTier: "CHILD",
      active: true,
      canLogin: false,
      // #2568: matches carry the server-calculated age, never a birth date.
      ageLabel: "8 years",
      alreadyInGroup: false,
      parentLinks: [],
    },
  ],
};

describe("admin-family-group-ui-helpers", () => {
  it("defaults child request selections and notification parents", () => {
    expect(buildInitialRequestSelections([baseRequest], {})).toEqual({
      "request-1": "child-1",
    });
    expect(buildInitialRequestNotificationParents([baseRequest], {})).toEqual({
      "request-1": "parent-1",
    });
  });

  it("defaults same-email adult requests to create when no matches exist", () => {
    const adultRequest: FamilyGroupRequest = {
      ...baseRequest,
      id: "request-2",
      type: "ADULT_REQUEST",
      childFirstName: null,
      childLastName: null,
      requestedFirstName: "Carla",
      requestedLastName: "Adult",
      requestedEmail: "ada@example.com",
      matchingMembers: [],
    };

    expect(buildInitialRequestSelections([adultRequest], {})).toEqual({
      "request-2": "__create__",
    });
  });

  it("maps search results with child age-tier filtering and group membership flags", () => {
    const results = mapFamilyGroupRequestSearchResults(baseRequest, [
      {
        id: "child-2",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
        canLogin: false,
        ageLabel: "8 years",
      },
      {
        id: "parent-1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ada@example.com",
        ageTier: "ADULT",
        active: true,
        canLogin: true,
      },
    ]);

    expect(results).toEqual([
      {
        id: "child-2",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
        canLogin: false,
        ageLabel: "8 years",
        parentLinks: [],
        alreadyInGroup: false,
      },
    ]);
  });

  it("keeps a searched row's parent links when it overwrites the same candidate", () => {
    // A search row wins over the same id from `matchingMembers`, so a search
    // response without `parentLinks` silently emptied the child-request
    // notification-recipient choices. The endpoint returns them; this pins that
    // the merge does not throw them away.
    const searched = mapFamilyGroupRequestSearchResults(baseRequest, [
      {
        id: "child-1",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
        canLogin: false,
        ageLabel: "8 years",
        parentLinks: [
          {
            id: "ann-1",
            firstName: "Ann",
            lastName: "Parent",
            email: "ann@example.com",
            parentLinkType: "PRIMARY",
          },
        ],
      },
    ]);

    const merged = mergeFamilyGroupRequestCandidates(baseRequest, searched);

    expect(merged).toHaveLength(1);
    expect(merged[0].parentLinks).toEqual([
      expect.objectContaining({ id: "ann-1", parentLinkType: "PRIMARY" }),
    ]);
  });

  it("builds shared-email clusters using effective email", () => {
    const members: FamilyGroupMemberRow[] = [
      {
        id: "adult-1",
        firstName: "Ada",
        lastName: "Parent",
        email: "ADA@EXAMPLE.COM",
        effectiveEmail: "ada@example.com",
        ageTier: "ADULT",
        active: true,
      },
      {
        id: "child-1",
        firstName: "Bea",
        lastName: "Child",
        email: "child@example.com",
        effectiveEmail: "ada@example.com",
        ageTier: "CHILD",
        active: true,
      },
      {
        id: "adult-2",
        firstName: "Cora",
        lastName: "Other",
        email: "cora@example.com",
        ageTier: "ADULT",
        active: true,
      },
    ];

    expect(buildSharedEmailClusters(members)).toEqual([
      {
        email: "ada@example.com",
        members: [members[0], members[1]],
      },
    ]);
  });

  it("summarizes removal requests with the subject member", () => {
    const removalRequest: FamilyGroupRequest = {
      ...baseRequest,
      id: "request-3",
      type: "REMOVAL_REQUEST",
      subjectMember: {
        id: "child-1",
        firstName: "Bea",
        lastName: "Child",
        email: "bea@example.com",
        ageTier: "CHILD",
        active: true,
      },
      matchingMembers: [],
    };

    expect(getFamilyGroupRequestSummary(removalRequest)).toBe(
      "Ada Parent wants to remove Bea Child from Parent Family."
    );
  });

  it("labels and summarizes GROUP_CREATE requests (#1681)", () => {
    const groupCreateRequest: FamilyGroupRequest = {
      ...baseRequest,
      id: "request-4",
      type: "GROUP_CREATE",
      familyGroup: { id: "group-new", name: "New Family", members: [] },
      invitedMember: {
        id: "partner-1",
        firstName: "Pat",
        lastName: "Partner",
        email: "pat@example.com",
      },
      matchingMembers: [],
    };

    expect(getFamilyGroupRequestTypeLabel(groupCreateRequest)).toBe(
      "New Family Group"
    );
    expect(getFamilyGroupRequestSummary(groupCreateRequest)).toBe(
      "Ada Parent wants to create the new family group New Family and invite Pat Partner."
    );
    expect(
      getFamilyGroupRequestSummary({ ...groupCreateRequest, invitedMember: null })
    ).toBe("Ada Parent wants to create the new family group New Family.");
    // GROUP_CREATE never seeds a member-record selection.
    expect(buildInitialRequestSelections([groupCreateRequest], {})).toEqual({});
  });
});

// #2256: formatFamilyGroupDate used to be a bare `toLocaleDateString()` — no
// locale, no time zone — so the six family-group surfaces that render through
// it (request "Requested" stamps, dates of birth on the review card) showed
// "4/16/2026" to a US-locale admin and could show the wrong calendar day to any
// admin whose machine sat behind New Zealand. These cases pin both halves:
// the rendered format, and independence from the runtime's own zone.
describe("formatFamilyGroupDate (#2256)", () => {
  // 2026-04-15T23:30:00Z is 2026-04-16 11:30 in Pacific/Auckland, so the NZ
  // calendar date differs from the UTC one at this instant.
  const INSTANT = "2026-04-15T23:30:00.000Z";
  const hostTimeZone = captureHostTimeZone();

  afterEach(() => {
    // A bare `delete process.env.TZ` does not invalidate Node's cached zone
    // (#2485) — `hostTimeZone.restore()` assigns the real host zone back
    // first, so it can't leak the fake one into a later test in this worker.
    hostTimeZone.restore();
  });

  it("renders the NZ calendar date in the app's standard medium format", () => {
    expect(formatFamilyGroupDate(INSTANT)).toBe("16 Apr 2026");
  });

  it("renders a date-only value (a date of birth) as that same calendar day", () => {
    expect(formatFamilyGroupDate("2018-01-01")).toBe("1 Jan 2018");
    expect(formatFamilyGroupDate("2014-08-28")).toBe("28 Aug 2014");
  });

  it("ignores the runtime's own time zone on both sides of the NZ date", () => {
    // UTC is behind NZ (still 15 April at this instant) and Kiritimati is ahead
    // of it (already 16 April, two hours later) — a formatter that leaned on the
    // ambient zone could not answer "16 Apr 2026" to both.
    process.env.TZ = "UTC";
    expect(formatFamilyGroupDate(INSTANT)).toBe("16 Apr 2026");
    process.env.TZ = "America/New_York";
    expect(formatFamilyGroupDate(INSTANT)).toBe("16 Apr 2026");
    process.env.TZ = "Pacific/Kiritimati";
    expect(formatFamilyGroupDate(INSTANT)).toBe("16 Apr 2026");
  });

  it("keeps the placeholder for missing values and never throws on a bad one", () => {
    expect(formatFamilyGroupDate(null)).toBe("Not provided");
    expect(formatFamilyGroupDate(undefined)).toBe("Not provided");
    expect(formatFamilyGroupDate("")).toBe("Not provided");
    // Intl.DateTimeFormat throws RangeError on an invalid Date, which would
    // take the whole request-review card down; the guard degrades instead.
    expect(formatFamilyGroupDate("not-a-date")).toBe("Not provided");
  });
});
