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
      // invite need never be accepted.
      //
      // The mapping is no longer inline. `toSubscriptionLockoutParticipants` reads a
      // persisted row's `consentStatus` AND a pre-persist row's planned
      // `memberGuestConsent.consentStatus`, which is exactly the two shapes this
      // route holds, so both lists go through the one helper. That matters more
      // than the inline form did: the helper originally read a field name that does
      // not exist in the schema, every persisted row answered `undefined`, and the
      // guard was inert while its own unit test stayed green. Asserting the helper
      // is what is called keeps the two shapes on one code path.
      const source = readRepoFile(site.file);
      const call = source.indexOf("evaluateNonMemberPricingRequirements(tx, {");
      const window = source.slice(call, call + 1600);
      expect(window).toContain("toSubscriptionLockoutParticipants([");
      expect(window).toContain("...booking.guests");
      expect(window).toContain("...normalizedNewGuests");
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
    // ...and the peek is only the FALLBACK: a caller that already resolved the mode
    // passes it, so the in-transaction gate takes no second pool connection at all.
    expect(source).toContain(
      "params.subscriptionLockoutMode ?? (await peekSubscriptionLockoutMode())",
    );
  });

  it("the exception-request re-evaluation reads through its own client", () => {
    // The override door: a member refused by a booking path re-submits the party
    // here, and this re-evaluation is what reproduces the violation server-side.
    const source = readRepoFile("src/lib/booking-exception-request-service.ts");
    expect(source).toContain("evaluateProposedPaidUpAdultPresence(db, {");
  });

  it("the exception-request re-evaluation carries D-12 presence, so the door opens", () => {
    // Without it, the PENDING cross-family adult a booking path correctly excluded
    // reads as present here, no violation is found, and the request machinery
    // refuses to create a request there is nothing to review — the 409 names a
    // workflow the member cannot enter. `ProposalGuest` deliberately does NOT carry
    // the fact (the proposal is frozen and hashed), so it is derived.
    const source = readRepoFile("src/lib/booking-exception-request-service.ts");
    expect(source).toContain("resolveProposalOperationalPresence(");
    expect(source).toContain("operationallyPresent: operationallyPresentFor(");
    // A new booking has no live rows, so every cross-family member guest is
    // somebody who WOULD be invited PENDING; a modification also consults the
    // stored consent status of the rows already on the booking, so a CONFIRMED
    // cross-family adult is not wrongly excluded.
    expect(source).toContain("{ requestedByMemberId: input.requestedByMemberId }");
    expect(source).toContain("bookingId: input.bookingId,");
    expect(source).toContain("computeMemberGuestBoundary(");
    expect(source).toContain("isOperationallyPresentConsent(row.consentStatus)");
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

describe("the sixth refusal site, and the paths that were missing (#2543)", () => {
  it("the modify APPLY path mode-gates its unpaid-member-guest refusal", () => {
    // `prepareGuestPlan` is the apply half of the edit flow whose preview is
    // modify-quote. Ungated it hard-blocked in every regime, so a member was quoted
    // the non-member price with an explanation and then refused on save with the
    // pre-#2543 403 — an edit that could never complete.
    const source = readRepoFile("src/lib/booking-modify-plan.ts");
    const lookup = source.indexOf("findUnpaidMemberGuestNames(tx, {");
    const refusal = source.indexOf(
      "All member guests must have a paid subscription before booking",
    );
    const gate = source.indexOf(
      '(subscriptionLockoutMode ?? "HARD_BLOCK") === "HARD_BLOCK"',
    );

    expect(lookup).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    // The lookup still runs in every mode: it is what raises the D-8 neutral
    // refusal for a beyond-family unpaid member guest, and that privacy boundary is
    // not the lockout policy's to relax. Only the refusal is gated.
    expect(lookup).toBeLessThan(gate);
    expect(gate).toBeLessThan(refusal);
  });

  it("the modify APPLY path evaluates the paid-up-adult requirement itself", () => {
    // Two holes: `PUT /api/bookings/[id]/modify` is reachable without ever calling
    // modify-quote, and the requirement was evaluated on ADDITIVE writes only, so
    // `removeGuestIds` could take the party's last paid-up adult member off a
    // booking the add path had just approved on the strength of their presence.
    const source = readRepoFile("src/lib/booking-modify-plan.ts");
    expect(source).toContain("evaluateNonMemberPricingRequirements(tx, {");
    expect(source).toContain("new PaidUpAdultMemberRequiredError(");
    // Over the PROPOSED party, which is what covers adds, removals and date
    // changes in one place instead of one gate per request shape.
    expect(source).toContain("participants: guestsForPricing.map(");
  });

  it("single-guest removal re-evaluates the requirement over what is left", () => {
    const source = readRepoFile("src/lib/booking-guest-removal-service.ts");
    expect(source).toContain("evaluateNonMemberPricingRequirements(tx, {");
    expect(source).toContain(
      "toSubscriptionLockoutParticipants(remainingGuests)",
    );
    // A consent DECLINE or EXPIRY is exempt — D-14 requires that a member who has
    // declined can always be taken off — and an ADMIN is skipped as everywhere else.
    expect(source).toContain('actorRole !== "ADMIN" && !consentAuthority');
  });

  it("the removal route answers the refusal with the shared body, before the generic ApiError branch", () => {
    const source = readRepoFile(
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    );
    const subclass = source.indexOf(
      "err instanceof PaidUpAdultMemberRequiredError",
    );
    const generic = source.indexOf("err instanceof ApiError");
    expect(subclass).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(-1);
    expect(subclass).toBeLessThan(generic);
    expect(source).toContain("buildPaidUpAdultRefusalBody(err.violation)");
  });

  it("the modify route answers the refusal with the shared body, before the generic ApiError branch", () => {
    const source = readRepoFile("src/app/api/bookings/[id]/modify/route.ts");
    const subclass = source.indexOf(
      "err instanceof PaidUpAdultMemberRequiredError",
    );
    const generic = source.indexOf("err instanceof ApiError");
    expect(subclass).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(-1);
    expect(subclass).toBeLessThan(generic);
  });

  it("the waitlist re-checks the requirement, outside the claiming transaction", () => {
    // The sweep reprices a STORED booking's money and passes no locked night
    // prices, so the whole stay re-bases. Both halves of the owner's rule now reach
    // it: the refusal, and the explanation on the offer.
    const source = readRepoFile("src/lib/waitlist.ts");
    const check = source.indexOf("evaluateNonMemberPricingRequirements(prisma, {");
    const transaction = source.indexOf("result = await prisma.$transaction(");
    expect(check).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(-1);
    expect(check).toBeLessThan(transaction);
    // Fails closed WITHOUT consuming the offer, exactly as the minimum-stay check
    // beside it does, so the member keeps their place.
    expect(source).toContain("revertSameLodgeOfferToWaitlisted(bookingId, offerLodgeId, {");
    expect(source).toContain('code: "PAID_UP_ADULT_MEMBER_REQUIRED"');
    expect(source).toContain("paidUpAdultRefusal: buildPaidUpAdultRefusalBody(");
  });

  it("the group-join refusal carries the path to the override door", () => {
    // The other four paths return `exceptionRequestPath`; this one destructured
    // everything except it, so a client written against the shared body rendered no
    // "ask a Booking Officer" link on this path alone.
    const lib = readRepoFile("src/lib/group-booking.ts");
    expect(lib).toContain("exceptionRequestPath: refusal.exceptionRequestPath");
    const route = readRepoFile("src/app/api/group-bookings/[code]/join/route.ts");
    expect(route).toContain("exceptionRequestPath: err.exceptionRequestPath");
  });
});

describe("the mode is threaded to the money, not re-read inside the locks (#2543)", () => {
  const THREADED = [
    ["src/lib/booking-create.ts", "input.subscriptionLockoutMode", 3],
    ["src/lib/booking-modify-plan.ts", "subscriptionLockoutMode,", 4],
    ["src/app/api/bookings/[id]/modify-quote/route.ts", "subscriptionLockoutMode,", 7],
    ["src/lib/waitlist.ts", "subscriptionLockoutMode,", 2],
  ] as const;

  it.each(THREADED)(
    "%s hands the resolved mode to every pricing call",
    (file, marker, atLeast) => {
      const source = readRepoFile(file);
      const occurrences = source.split(marker).length - 1;
      expect(occurrences, `${file} — ${marker}`).toBeGreaterThanOrEqual(atLeast);
    },
  );

  it("the batch modify service resolves the mode before it opens its transaction", () => {
    // `resolveSubscriptionLockoutMode` can refresh the financial-year cache from
    // Xero. Inside the transaction that holds lock(1) and the per-lodge capacity
    // lock, that is the one thing the booking rules forbid outright.
    const source = readRepoFile("src/lib/booking-batch-modification-service.ts");
    const modeRead = source.indexOf("await resolveSubscriptionLockoutMode()");
    const transaction = source.indexOf("withOptionalTransaction(callerTx,");
    expect(modeRead).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(-1);
    expect(modeRead).toBeLessThan(transaction);
  });

  it("the guest-removal route resolves the mode before it opens its transaction", () => {
    const source = readRepoFile(
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    );
    const modeRead = source.indexOf("await resolveSubscriptionLockoutMode()");
    const transaction = source.indexOf("prisma.$transaction((tx) =>");
    expect(modeRead).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(-1);
    expect(modeRead).toBeLessThan(transaction);
  });

  it("the waitlist sweep resolves the mode before it opens its transaction", () => {
    const source = readRepoFile("src/lib/waitlist.ts");
    const modeRead = source.indexOf("await resolveSubscriptionLockoutMode()");
    const transaction = source.indexOf("await prisma.$transaction(async (tx) => {");
    expect(modeRead).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(-1);
    expect(modeRead).toBeLessThan(transaction);
  });
});
