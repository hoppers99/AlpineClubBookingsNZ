import { describe, it, expect, vi } from "vitest";
import {
  listBookingPartnerSharingCandidates,
  mayShareDoubleBed,
  mayShareDoubleBedWith,
} from "@/lib/double-bed-sharing";
import { canonicalPartnerPair } from "@/lib/member-partner-link-shared";

type FakeMember = {
  id: string;
  ageTier: string;
  active: boolean;
};

type FakePartnerLink = {
  memberAId: string;
  memberBId: string;
  status: string;
};

// The predicate takes a db client, so tiny fakes for `member.findMany` and
// `memberPartnerLink.findUnique` are all the test needs — no prisma mock.
// findMany filters the seeded members by the `where: { id: { in: [...] } }`
// clause the predicate builds; findUnique matches a seeded link by the
// canonical pair the predicate looks up.
function fakeDb(members: FakeMember[], links: FakePartnerLink[] = []) {
  return {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        const ids = args.where.id.in;
        return members.filter((member) => ids.includes(member.id));
      }),
    },
    memberPartnerLink: {
      findUnique: vi.fn(
        async (args: {
          where: {
            memberAId_memberBId: { memberAId: string; memberBId: string };
          };
        }) => {
          const pair = args.where.memberAId_memberBId;
          return (
            links.find(
              (link) =>
                link.memberAId === pair.memberAId &&
                link.memberBId === pair.memberBId,
            ) ?? null
          );
        },
      ),
    },
  } as unknown as NonNullable<Parameters<typeof mayShareDoubleBed>[2]>;
}

const adult = (id: string): FakeMember => ({ id, ageTier: "ADULT", active: true });

// Seed a link the way the service stores it: as the canonical ordered pair.
const link = (
  memberOneId: string,
  memberTwoId: string,
  status: string,
): FakePartnerLink => ({
  ...canonicalPartnerPair(memberOneId, memberTwoId),
  status,
});

describe("mayShareDoubleBed", () => {
  it("allows two active adults with a CONFIRMED partner link", async () => {
    const db = fakeDb([adult("a"), adult("b")], [link("a", "b", "CONFIRMED")]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(true);
  });

  it("is symmetric: argument order does not matter", async () => {
    const db = fakeDb([adult("a"), adult("b")], [link("a", "b", "CONFIRMED")]);
    await expect(mayShareDoubleBed("b", "a", db)).resolves.toBe(true);
  });

  it("rejects a PENDING (unconfirmed) partner link", async () => {
    const db = fakeDb([adult("a"), adult("b")], [link("a", "b", "PENDING")]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects two adults with no partner link (family-group co-membership no longer suffices)", async () => {
    const db = fakeDb([adult("a"), adult("b")]);
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects when either member is a minor, even with a CONFIRMED link", async () => {
    const db = fakeDb(
      [adult("a"), { id: "b", ageTier: "YOUTH", active: true }],
      [link("a", "b", "CONFIRMED")],
    );
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects when either member is inactive, even with a CONFIRMED link", async () => {
    const db = fakeDb(
      [adult("a"), { id: "b", ageTier: "ADULT", active: false }],
      [link("a", "b", "CONFIRMED")],
    );
    await expect(mayShareDoubleBed("a", "b", db)).resolves.toBe(false);
  });

  it("rejects the same member id (cannot partner with self)", async () => {
    const db = fakeDb([adult("a")]);
    await expect(mayShareDoubleBed("a", "a", db)).resolves.toBe(false);
  });

  it("rejects when a member id does not resolve", async () => {
    const db = fakeDb([adult("a")]);
    await expect(mayShareDoubleBed("a", "ghost", db)).resolves.toBe(false);
  });

  it("rejects empty member ids without querying", async () => {
    const db = fakeDb([adult("a")]);
    await expect(mayShareDoubleBed("", "b", db)).resolves.toBe(false);
    expect(db.member.findMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

/*
 * The batched form must answer exactly what the single-pair form answers, for
 * every candidate, or the range path (#2251) would place partners the board
 * would refuse. These cases are the ones above, asked all at once.
 */
describe("mayShareDoubleBedWith (batched)", () => {
  function batchedDb(members: FakeMember[], links: FakePartnerLink[] = []) {
    return {
      member: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
          const ids = args.where.id.in;
          return members.filter((member) => ids.includes(member.id));
        }),
      },
      memberPartnerLink: {
        findMany: vi.fn(
          async (args: {
            where: {
              status: string;
              OR: { memberAId: string; memberBId: string }[];
            };
          }) =>
            links.filter(
              (candidate) =>
                candidate.status === args.where.status &&
                args.where.OR.some(
                  (pair) =>
                    pair.memberAId === candidate.memberAId &&
                    pair.memberBId === candidate.memberBId,
                ),
            ),
        ),
      },
    } as unknown as NonNullable<Parameters<typeof mayShareDoubleBedWith>[2]>;
  }

  it("agrees with mayShareDoubleBed on every candidate, in ONE pair of queries", async () => {
    const members = [
      adult("anchor"),
      adult("confirmed"),
      adult("pending"),
      adult("unlinked"),
      { id: "minor", ageTier: "YOUTH", active: true },
      { id: "inactive", ageTier: "ADULT", active: false },
    ];
    const links = [
      link("anchor", "confirmed", "CONFIRMED"),
      link("anchor", "pending", "PENDING"),
      link("anchor", "minor", "CONFIRMED"),
      link("anchor", "inactive", "CONFIRMED"),
    ];
    const candidates = [
      "confirmed",
      "pending",
      "unlinked",
      "minor",
      "inactive",
      "ghost",
      "anchor",
    ];

    const batched = batchedDb(members, links);
    const eligible = await mayShareDoubleBedWith("anchor", candidates, batched);

    expect([...eligible].sort()).toEqual(["confirmed"]);
    // Batched means batched: one member lookup, one link lookup, whatever the
    // candidate count — that is the whole point of it.
    expect(batched.member.findMany as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(
      batched.memberPartnerLink.findMany as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(1);

    for (const candidate of candidates) {
      const single = await mayShareDoubleBed(
        "anchor",
        candidate,
        fakeDb(members, links),
      );
      expect(eligible.has(candidate)).toBe(single);
    }
  });

  it("returns nothing when the anchor itself is not an active adult", async () => {
    const db = batchedDb(
      [{ id: "anchor", ageTier: "ADULT", active: false }, adult("confirmed")],
      [link("anchor", "confirmed", "CONFIRMED")],
    );
    await expect(
      mayShareDoubleBedWith("anchor", ["confirmed"], db),
    ).resolves.toEqual(new Set());
  });

  it("queries nothing for an empty candidate list", async () => {
    const db = batchedDb([adult("anchor")]);
    await expect(mayShareDoubleBedWith("anchor", [], db)).resolves.toEqual(
      new Set(),
    );
    expect(db.member.findMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("listBookingPartnerSharingCandidates", () => {
  type FakeGuest = {
    memberId: string | null;
    firstName: string;
    lastName: string;
  };

  function candidatesDb(
    guests: FakeGuest[],
    links: FakePartnerLink[],
    members: Array<FakeMember & { firstName: string; lastName: string }>,
  ) {
    return {
      bookingGuest: {
        findMany: vi.fn(async () =>
          guests.filter((guest) => guest.memberId !== null),
        ),
      },
      memberPartnerLink: {
        findMany: vi.fn(
          async (args: {
            where: {
              OR: Array<
                | { memberAId: { in: string[] } }
                | { memberBId: { in: string[] } }
              >;
            };
          }) => {
            const inA = (args.where.OR[0] as { memberAId: { in: string[] } })
              .memberAId.in;
            return links.filter(
              (candidate) =>
                candidate.status === "CONFIRMED" &&
                (inA.includes(candidate.memberAId) ||
                  inA.includes(candidate.memberBId)),
            );
          },
        ),
      },
      member: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
          members.filter(
            (member) =>
              args.where.id.in.includes(member.id) &&
              member.active &&
              member.ageTier === "ADULT",
          ),
        ),
      },
    } as unknown as NonNullable<
      Parameters<typeof listBookingPartnerSharingCandidates>[1]
    >;
  }

  const guest = (memberId: string | null, name: string): FakeGuest => ({
    memberId,
    firstName: name,
    lastName: "Guest",
  });
  const namedAdult = (id: string, name: string) => ({
    ...adult(id),
    firstName: name,
    lastName: "Member",
  });

  it("offers the confirmed partner of a booking member with the anchor named", async () => {
    const db = candidatesDb(
      [guest("m-anna", "Anna")],
      [link("m-anna", "m-ben", "CONFIRMED")],
      [namedAdult("m-ben", "Ben")],
    );
    const candidates = await listBookingPartnerSharingCandidates("b1", db);
    expect(candidates).toEqual([
      {
        id: "m-ben",
        firstName: "Ben",
        lastName: "Member",
        partnerOfMemberId: "m-anna",
        partnerOfName: "Anna Guest",
      },
    ]);
  });

  it("offers nothing when the partner is already a guest on the booking", async () => {
    const db = candidatesDb(
      [guest("m-anna", "Anna"), guest("m-ben", "Ben")],
      [link("m-anna", "m-ben", "CONFIRMED")],
      [namedAdult("m-ben", "Ben")],
    );
    await expect(
      listBookingPartnerSharingCandidates("b1", db),
    ).resolves.toEqual([]);
  });

  it("drops partners who are no longer active adults", async () => {
    const db = candidatesDb(
      [guest("m-anna", "Anna")],
      [link("m-anna", "m-ben", "CONFIRMED")],
      [{ ...namedAdult("m-ben", "Ben"), active: false }],
    );
    await expect(
      listBookingPartnerSharingCandidates("b1", db),
    ).resolves.toEqual([]);
  });

  it("returns empty without link queries when the booking has no member guests", async () => {
    const db = candidatesDb([guest(null, "Walkin")], [], []);
    await expect(
      listBookingPartnerSharingCandidates("b1", db),
    ).resolves.toEqual([]);
    expect(
      (db as unknown as { memberPartnerLink: { findMany: ReturnType<typeof vi.fn> } })
        .memberPartnerLink.findMany,
    ).not.toHaveBeenCalled();
  });
});
