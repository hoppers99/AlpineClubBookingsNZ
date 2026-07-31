// MG3 (#2308) — the pure find model.
//
// This file pins the rules that decide how much of the membership a member can
// learn by typing. They are small, pure functions on purpose: the privacy
// envelope is much easier to defend when it is a handful of assertions about a
// prefix parser and a cap than when it is spread across two route handlers.
import { describe, expect, it } from "vitest";

import {
  EMPTY_MEMBER_GUEST_CANDIDATES,
  MEMBER_GUEST_CANDIDATE_ADULT_TIERS,
  MEMBER_GUEST_CANDIDATE_MINOR_TIERS,
  MEMBER_GUEST_FIND_COPY,
  MEMBER_GUEST_SEARCH_MIN_CHARS,
  MEMBER_GUEST_SEARCH_RESULT_CAP,
  capMemberGuestCandidates,
  classifyMemberGuestFindInput,
  describeHouseholdCandidatePrompt,
  hasIndistinguishableMemberGuestCandidates,
  memberGuestResolveAgeTiers,
  memberGuestSearchAgeTiers,
  normalizeMemberGuestEmail,
  parseMemberGuestSearchQuery,
  shouldAutoResolveMemberGuestCandidate,
  toMemberGuestCandidate,
  truncateSearchQueryForAudit,
  type MemberGuestCandidate,
} from "@/lib/member-guest-find";

function candidate(overrides: Partial<MemberGuestCandidate> = {}): MemberGuestCandidate {
  return {
    memberId: "m-1",
    firstName: "Sam",
    lastName: "Whittaker",
    ageTier: "ADULT",
    ...overrides,
  };
}

describe("classifyMemberGuestFindInput — one box that takes either (owner answer 2)", () => {
  it("treats anything containing @ as an email intent, well-formed or not", () => {
    expect(classifyMemberGuestFindInput("sam@example.co.nz")).toEqual({
      kind: "EMAIL",
      email: "sam@example.co.nz",
      wellFormed: true,
    });
    // The trap the owner asked not to ship: half an address must NOT fall
    // through to a name search that silently matches nothing.
    expect(classifyMemberGuestFindInput("sam.whittaker@exampl")).toEqual({
      kind: "EMAIL",
      email: "sam.whittaker@exampl",
      wellFormed: false,
    });
  });

  it("treats anything without @ as a name query, and empty as empty", () => {
    expect(classifyMemberGuestFindInput("sam whitt")).toEqual({
      kind: "NAME",
      q: "sam whitt",
    });
    expect(classifyMemberGuestFindInput("   ")).toEqual({ kind: "EMPTY" });
  });

  it("normalises an email exactly as the partner-link resolve does", () => {
    expect(normalizeMemberGuestEmail("  SAM@Example.CO.NZ ")).toBe("sam@example.co.nz");
    expect(classifyMemberGuestFindInput("  SAM@Example.CO.NZ ").kind).toBe("EMAIL");
    expect(
      (classifyMemberGuestFindInput("  SAM@Example.CO.NZ ") as { email: string }).email,
    ).toBe("sam@example.co.nz");
  });
});

describe("parseMemberGuestSearchQuery — prefix-only, never contains", () => {
  it("refuses anything under the two-character floor", () => {
    expect(parseMemberGuestSearchQuery("s")).toEqual({ ok: false });
    expect(parseMemberGuestSearchQuery("  s  ")).toEqual({ ok: false });
    expect(MEMBER_GUEST_SEARCH_MIN_CHARS).toBe(2);
  });

  it("splits on a space into first-name AND last-name prefixes", () => {
    expect(parseMemberGuestSearchQuery("sam whitt")).toEqual({
      ok: true,
      terms: { kind: "FIRST_AND_LAST", firstPrefix: "sam", lastPrefix: "whitt" },
      normalized: "sam whitt",
    });
  });

  it("never produces an EMPTY prefix, which would match the whole roll", () => {
    // A trailing space must collapse to one term rather than "sam" AND "".
    const parsed = parseMemberGuestSearchQuery("sam ");
    expect(parsed).toEqual({
      ok: true,
      terms: { kind: "SINGLE", prefix: "sam" },
      normalized: "sam",
    });
    const runs = parseMemberGuestSearchQuery("sam    whitt");
    expect(runs.ok && runs.terms).toEqual({
      kind: "FIRST_AND_LAST",
      firstPrefix: "sam",
      lastPrefix: "whitt",
    });
  });
});

describe("age tiers — the minors sub-toggle gates the type-ahead only (D-20)", () => {
  it("excludes minors from the name search by default and includes them when opted in", () => {
    expect(memberGuestSearchAgeTiers(false)).toEqual([...MEMBER_GUEST_CANDIDATE_ADULT_TIERS]);
    for (const minor of MEMBER_GUEST_CANDIDATE_MINOR_TIERS) {
      expect(memberGuestSearchAgeTiers(false)).not.toContain(minor);
      expect(memberGuestSearchAgeTiers(true)).toContain(minor);
    }
  });

  it("never gates the EMAIL resolve on the sub-setting — a minor stays resolvable by household address", () => {
    for (const minor of MEMBER_GUEST_CANDIDATE_MINOR_TIERS) {
      expect(memberGuestResolveAgeTiers()).toContain(minor);
    }
  });

  it("never offers an age-exempt account in either mode — it can never be a booking guest", () => {
    expect(memberGuestResolveAgeTiers()).not.toContain("NOT_APPLICABLE");
    expect(memberGuestSearchAgeTiers(true)).not.toContain("NOT_APPLICABLE");
    expect(memberGuestSearchAgeTiers(false)).not.toContain("NOT_APPLICABLE");
  });
});

describe("capMemberGuestCandidates — a boolean, never a count", () => {
  it("caps at ten and reports truncation without a total", () => {
    const rows = Array.from({ length: MEMBER_GUEST_SEARCH_RESULT_CAP + 1 }, (_, i) =>
      candidate({ memberId: `m-${i}` }),
    );
    const response = capMemberGuestCandidates(rows);
    expect(response.candidates).toHaveLength(MEMBER_GUEST_SEARCH_RESULT_CAP);
    expect(response.truncated).toBe(true);
    // The whole point: no number anywhere in the envelope that describes rows
    // the caller is NOT being shown.
    expect(JSON.stringify(response)).not.toContain(String(rows.length));
    expect(Object.keys(response).sort()).toEqual(["candidates", "truncated"]);
  });

  it("reports no truncation when everything fitted", () => {
    expect(capMemberGuestCandidates([candidate()]).truncated).toBe(false);
  });
});

describe("toMemberGuestCandidate — the row shape is exactly D-19's four fields", () => {
  it("drops anything else a select might one day grow", () => {
    const row = {
      id: "m-9",
      firstName: "Sam",
      lastName: "Whittaker",
      ageTier: "ADULT" as const,
      // The fields a careless `select` would add, every one of which D-19 forbids.
      email: "sam@example.co.nz",
      streetCity: "Ohakune",
      membershipTypeId: "mt-1",
      photoUrl: "/x.png",
    };
    expect(toMemberGuestCandidate(row)).toEqual({
      memberId: "m-9",
      firstName: "Sam",
      lastName: "Whittaker",
      ageTier: "ADULT",
    });
  });
});

describe("auto-resolve and same-name handling", () => {
  it("auto-resolves exactly one candidate, and never out of a truncated set", () => {
    expect(shouldAutoResolveMemberGuestCandidate({ candidates: [candidate()] })).toBe(true);
    expect(
      shouldAutoResolveMemberGuestCandidate({ candidates: [candidate()], truncated: true }),
    ).toBe(false);
    expect(
      shouldAutoResolveMemberGuestCandidate({
        candidates: [candidate(), candidate({ memberId: "m-2" })],
      }),
    ).toBe(false);
    expect(shouldAutoResolveMemberGuestCandidate(EMPTY_MEMBER_GUEST_CANDIDATES)).toBe(false);
  });

  it("spots two rows a booker cannot tell apart from what they are shown", () => {
    const twoJohns = [
      candidate({ memberId: "a", firstName: "John", lastName: "Smith" }),
      candidate({ memberId: "b", firstName: "john", lastName: "SMITH" }),
    ];
    expect(hasIndistinguishableMemberGuestCandidates(twoJohns)).toBe(true);
    expect(
      hasIndistinguishableMemberGuestCandidates([
        candidate({ memberId: "a", firstName: "John" }),
        candidate({ memberId: "b", firstName: "Jane" }),
      ]),
    ).toBe(false);
  });
});

describe("the panel's copy — load-bearing privacy sentences", () => {
  it("keeps the ONE fixed sentence for every empty email result", () => {
    expect(MEMBER_GUEST_FIND_COPY.noEmailMatch).toBe(
      "No bookable member found for that email.",
    );
  });

  it("never lets the truncation sentence acquire a count", () => {
    expect(MEMBER_GUEST_FIND_COPY.truncated).toBe("Keep typing to narrow this down.");
    expect(MEMBER_GUEST_FIND_COPY.truncated).not.toMatch(/\d/);
  });

  it("points a same-name collision at the email address rather than a new field", () => {
    expect(MEMBER_GUEST_FIND_COPY.sameName).toBe(
      "Two members match that name — use their email address to be sure.",
    );
    // The two things D-19 forbids adding to a row to break the tie.
    expect(MEMBER_GUEST_FIND_COPY.sameName).not.toMatch(/town|suburb|photo/i);
  });

  it("says out loud, in the default mode, that the tool does not list members", () => {
    expect(MEMBER_GUEST_FIND_COPY.emailHint).toContain("We don't list members here");
  });

  it("counts a household only over rows the booker is about to read", () => {
    expect(describeHouseholdCandidatePrompt(3)).toBe(
      "Three members use that address. Which one are you adding?",
    );
  });
});

describe("truncateSearchQueryForAudit", () => {
  it("bounds what a typed fragment can store on an audit row", () => {
    expect(truncateSearchQueryForAudit("x".repeat(500))).toHaveLength(64);
  });
});
