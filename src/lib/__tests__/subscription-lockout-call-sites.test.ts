// #2543 — the five booking write paths, read off the real source files.
//
// WHY STRUCTURAL AND NOT BEHAVIOURAL. Three of this issue's requirements cannot be
// observed from behaviour:
//
//   * "all five write paths enforce CONSISTENTLY" is a claim about a set of files.
//     A behavioural test of four of them passes just as green while the fifth
//     quietly keeps hard-blocking, and the fifth is the one a club notices;
//   * "the HARD_BLOCK refusal is mode-gated, but the member-guest LOOKUP still
//     runs" is a positional property. Moving the whole block behind the mode check
//     gives identical results under HARD_BLOCK and silently drops the D-8
//     cross-family privacy refusal under NON_MEMBER_PRICING;
//   * "the policy read happens before the transaction opens" gives the same answer
//     wherever it sits — it just holds the per-lodge capacity lock while doing it,
//     and `resolveSubscriptionLockoutMode` can reseed the financial-year cache
//     from Xero. A provider call under that lock is the one thing the booking
//     rules forbid outright.
//
// For those three, reading the source is not a shortcut; it is the only honest
// test. Mirrors the convention in member-guest-add-call-sites.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/** The five paths the issue names, and how each of them refuses. */
const WRITE_PATHS = [
  {
    name: "POST /api/bookings (create)",
    file: "src/app/api/bookings/route.ts",
  },
  {
    name: "POST /api/bookings/[id]/confirm-draft",
    file: "src/app/api/bookings/[id]/confirm-draft/route.ts",
  },
  {
    name: "POST /api/bookings/[id]/modify-quote",
    file: "src/app/api/bookings/[id]/modify-quote/route.ts",
  },
  {
    name: "POST /api/bookings/[id]/guests",
    file: "src/app/api/bookings/[id]/guests/route.ts",
  },
  {
    name: "group-booking join",
    file: "src/lib/group-booking.ts",
  },
] as const;

describe("every booking write path resolves the club's lockout mode (#2543)", () => {
  for (const site of WRITE_PATHS) {
    it(`${site.name} resolves the mode and evaluates the requirements`, () => {
      const source = readRepoFile(site.file);
      expect(source).toContain("resolveSubscriptionLockoutMode()");
      expect(source).toContain("evaluateNonMemberPricingRequirements(");
    });
  }

  it("resolves the mode exactly once per request on each path", () => {
    // Resolved once and passed down, so the HARD_BLOCK gate and the
    // paid-up-adult requirement cannot branch on different answers if an admin
    // saves the setting mid-request — which would refuse under one regime while
    // pricing under the other.
    for (const site of WRITE_PATHS) {
      const source = readRepoFile(site.file);
      const calls = source.match(/resolveSubscriptionLockoutMode\(\)/g) ?? [];
      expect(calls, site.name).toHaveLength(1);
    }
  });

  it("passes the resolved mode into the evaluation rather than letting it re-read", () => {
    for (const site of WRITE_PATHS) {
      const source = readRepoFile(site.file);
      const call = source.indexOf("evaluateNonMemberPricingRequirements(");
      // The `mode:` argument appears within the call's own argument object.
      const window = source.slice(call, call + 400);
      expect(window, site.name).toContain("mode: subscriptionLockoutMode");
    }
  });
});

describe("the HARD_BLOCK refusals are mode-gated, and only the refusals (#2543)", () => {
  it.each(WRITE_PATHS.map((site) => [site.name, site.file] as const))(
    "%s gates its subscription refusal on HARD_BLOCK",
    (_name, file) => {
      const source = readRepoFile(file);
      expect(source).toContain('subscriptionLockoutMode === "HARD_BLOCK"');
    },
  );

  it.each([
    ["POST /api/bookings (create)", "src/app/api/bookings/route.ts", "findUnpaidMemberGuests("],
    [
      "POST /api/bookings/[id]/modify-quote",
      "src/app/api/bookings/[id]/modify-quote/route.ts",
      "findUnpaidMemberGuestNames(",
    ],
    [
      "POST /api/bookings/[id]/guests",
      "src/app/api/bookings/[id]/guests/route.ts",
      "findUnpaidMemberGuestNames(",
    ],
    ["group-booking join", "src/lib/group-booking.ts", "findUnpaidMemberGuests("],
  ] as const)(
    "%s still RUNS the member-guest lookup under every mode",
    (name, file, lookup) => {
      // The lookup is what raises the D-8 neutral refusal for an unpaid member
      // guest from beyond the booker's family. That privacy boundary is not the
      // lockout policy's to relax — only the 403 below it is mode-gated.
      //
      // Two things are asserted, and both matter. First that the mode check sits
      // in the SAME condition as the unpaid-guest count, i.e. it gates the
      // refusal. Second that the lookup call precedes that condition, i.e. it is
      // not itself inside the gated block. Together those rule out the mistake:
      // wrapping the lookup AND the refusal in one `if (mode === HARD_BLOCK)`,
      // which behaves identically under HARD_BLOCK and silently drops the D-8
      // refusal under NON_MEMBER_PRICING.
      const source = readRepoFile(file);
      const lookupCall = source.indexOf(lookup);
      const refusalCondition = source.indexOf("unpaidMemberGuests.length > 0");

      expect(lookupCall, name).toBeGreaterThan(-1);
      expect(refusalCondition, name).toBeGreaterThan(-1);

      const condition = source.slice(
        Math.max(0, refusalCondition - 200),
        refusalCondition,
      );
      expect(condition, name).toContain(
        'subscriptionLockoutMode === "HARD_BLOCK"',
      );
      expect(lookupCall, name).toBeLessThan(refusalCondition);
    },
  );
});

describe("no lockout policy read inside a booking transaction (#2543)", () => {
  const TRANSACTIONAL_SITES = [
    {
      name: "api/bookings/[id]/guests/route.ts",
      file: "src/app/api/bookings/[id]/guests/route.ts",
      transactionMarker: "await prisma.$transaction(",
    },
  ] as const;

  for (const site of TRANSACTIONAL_SITES) {
    it(`${site.name} resolves the mode before it opens its transaction`, () => {
      const source = readRepoFile(site.file);
      const modeRead = source.indexOf("await resolveSubscriptionLockoutMode()");
      const transaction = source.indexOf(site.transactionMarker);

      expect(modeRead).toBeGreaterThan(-1);
      expect(transaction).toBeGreaterThan(-1);
      expect(modeRead).toBeLessThan(transaction);
    });

    it(`${site.name} applies D-12 presence to the rows the add is about to create`, () => {
      // A cross-family member guest is added PENDING. Without this the rule would
      // be trivially satisfiable: add any paid-up adult member as a guest, and the
      // invite need never be accepted. Structural because the mapping happens
      // inline in the route's participant list — there is no seam to call.
      const source = readRepoFile(site.file);
      const call = source.indexOf("evaluateNonMemberPricingRequirements(tx, {");
      const window = source.slice(call, call + 1600);
      expect(window).toContain("operationallyPresent: isOperationallyPresentConsent(");
      expect(window).toContain("guest.memberGuestConsent?.consentStatus");
    });

    it(`${site.name} passes the transaction client to the in-transaction evaluation`, () => {
      // Inside the transaction the evaluation must read through `tx`, so its
      // queries participate in the advisory lock rather than racing it on a second
      // connection.
      const source = readRepoFile(site.file);
      const transaction = source.indexOf(site.transactionMarker);
      const inTransaction = source.slice(transaction);
      expect(inTransaction).toContain(
        "evaluateNonMemberPricingRequirements(tx, {",
      );
    });
  }

  it("the pricing gate uses the peek reader, which cannot reach Xero", () => {
    // `resolveGuestRateMembershipTypes` runs inside booking transactions that hold
    // the per-lodge capacity lock. `resolveSubscriptionLockoutMode` reseeds the
    // financial-year cache and can therefore reach Xero for the organisation's
    // accounting year; `peekSubscriptionLockoutMode` cannot. The pricing gate must
    // use the latter, and nothing but the latter.
    const source = readRepoFile("src/lib/membership-type-policy.ts");
    expect(source).toContain("peekSubscriptionLockoutMode()");
    expect(source).not.toContain("resolveSubscriptionLockoutMode");
  });

  it("the exception-request re-evaluation reads through its own client", () => {
    // The override door: a member refused by a booking path re-submits the party
    // here, and this re-evaluation is what reproduces the violation server-side.
    const source = readRepoFile("src/lib/booking-exception-request-service.ts");
    expect(source).toContain("evaluateProposedPaidUpAdultPresence(db, {");
  });
});

describe("the refusal body is built in one place (#2543)", () => {
  it.each(WRITE_PATHS.map((site) => [site.name, site.file] as const))(
    "%s builds its refusal from the shared helper",
    (name, file) => {
      // Five paths describing the same refusal five ways is how a member ends up
      // told they may ask a Booking Officer on four screens and not on the fifth.
      const source = readRepoFile(file);
      expect(source, name).toContain("buildPaidUpAdultRefusalBody(");
    },
  );

  it("the guests route tests its own error subclass before the shared ApiError branch", () => {
    // PaidUpAdultMemberRequiredError extends ApiError. Handled in the wrong order,
    // the generic branch flattens it to a bare sentence and closes the exception
    // door the refusal promises.
    const source = readRepoFile("src/app/api/bookings/[id]/guests/route.ts");
    const subclass = source.indexOf("err instanceof PaidUpAdultMemberRequiredError");
    const shared = source.indexOf("err instanceof SharedApiError");

    expect(subclass).toBeGreaterThan(-1);
    if (shared > -1) {
      expect(subclass).toBeLessThan(shared);
    }
  });
});
