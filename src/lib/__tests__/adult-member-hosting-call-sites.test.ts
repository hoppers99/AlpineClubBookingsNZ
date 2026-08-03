// #2569 — the hosting policy's call sites, read off the real source files.
//
// WHY STRUCTURAL AND NOT BEHAVIOURAL. Four of this issue's requirements are claims
// about a SET OF FILES rather than about an answer, and a behavioural test of the
// sites that exist today passes just as green when a new one is added:
//
//   * "one canonical server-side resolver" (§6) is a claim that quote calculation,
//     confirmation, payment completion, waitlist promotion, group joins,
//     modification, officer approval and member previews do NOT each carry their
//     own copy of the inheritance rule. A second copy gives identical answers right
//     up to the day a club overrides one dimension and inherits the other;
//   * "the school and organisation carve-out, and only that" (§13) is a claim that
//     exactly one call site passes `REVIEW_ONLY`. A second one, added for a reason
//     that felt local, silently exempts a member-owned flow from a refusal the club
//     switched on — and nothing in the exempted path's own tests would notice. This
//     lane found one: the MEMBER whole-lodge approval had been exempted under the
//     §13 comment, and a member booking the whole lodge for their own party is not a
//     school, an organisation, a teacher or a custodian;
//   * "every refusing surface hands back an answer the caller can act on" is
//     positional: `AdultMemberHostingRequiredError` extends `ApiError`, so a route
//     that catches it BELOW its generic branch answers a bare 409 with no code, no
//     frozen violation and no exception door, and looks fine in review;
//   * "the create path reads the policy before it opens its transaction" gives the
//     same answer wherever it sits — it just holds the per-lodge capacity lock
//     while doing it, which is the pool-starvation shape the booking rules forbid.
//
// Plus one that is not a requirement but a trap this lane walked into: Prisma's
// `select` is NOT typechecked for unknown keys through the narrow `Pick<PrismaClient,
// ...>` interface these paths use, so a renamed column in the policy loader's select
// is a runtime failure on every booking write path with a green typecheck.
//
// Mirrors the convention in subscription-lockout-call-sites.test.ts (#2543).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * The same source with its comments removed.
 *
 * Every sweep below is a claim about CODE, and this repository comments heavily —
 * `booking-request.ts` explains in prose that the school path passes
 * `enforcement: "REVIEW_ONLY"`, and the officer routes explain in prose that they
 * deliberately send no `exceptionRequestPath`. A plain text search reads both as
 * call sites and the assertions become the opposite of what they say.
 *
 * Block comments and whole-line `//` comments only: a trailing comment on a line of
 * code is left alone rather than risking a `//` inside a string literal.
 */
function readRepoCode(relativePath: string): string {
  return readRepoFile(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/**
 * The name this file binds the SHARED `ApiError` to, or null if it does not import
 * it. Two routes carry a LOCAL class of the same name and alias the shared one, so
 * an ordering assertion written against the bare identifier compares a typed
 * refusal against a branch that can never catch it.
 */
function sharedApiErrorName(source: string): string | null {
  const match = source.match(
    /import\s*\{[^}]*\bApiError(?:\s+as\s+(\w+))?[^}]*\}\s*from\s*"@\/lib\/api-error"/,
  );
  if (!match) return null;
  return match[1] ?? "ApiError";
}

/**
 * Every non-test source file under `src/` that names `identifier`, as sorted
 * repo-relative POSIX paths.
 *
 * For assertions of the form "this belongs to exactly these paths". A hand-listed
 * set of files is not that assertion: it passes when a NEW site starts using the
 * thing, which is the only way the claim can ever be broken. Tests are excluded
 * because they legitimately name whatever they assert about.
 */
function sourceFilesNaming(identifier: string): string[] {
  const root = path.resolve(process.cwd(), "src");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      if (readRepoCode(path.relative(process.cwd(), full)).includes(identifier)) {
        found.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("one authoritative evaluator and one resolver (#2569 §6, §7)", () => {
  it("resolves the club/lodge inheritance in exactly four places, none of them a booking path", () => {
    // The pure resolver (its own definition), the loader every booking write path
    // goes through, the admin card's effective view, and the public booking-rules
    // sentence. A booking path appearing here would be a SECOND implementation of
    // the inheritance rule — the thing §6 forbids by name.
    expect(sourceFilesNaming("resolveAdultMemberHostingPolicy(")).toEqual([
      "src/app/api/admin/booking-policies/adult-member-hosting/route.ts",
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/policies/adult-member-hosting.ts",
      "src/lib/public-page-content-tokens.ts",
    ]);
  });

  it("calls the pure evaluator only from the review service", () => {
    // §7: extend the shared evaluator, never write a second definition of a
    // qualifying adult member. Every caller reaches it through the review service,
    // which is also the only place that loads the participants.
    expect(sourceFilesNaming("evaluateAdultMemberHostingWithPolicy(")).toEqual([
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/policies/adult-member-hosting.ts",
    ]);
  });

  it("selects exactly the host-scope columns the schema declares", () => {
    // The loader's `select` is narrowed, so an omitted scope column reads as "this
    // row did not decide" and quietly widens or narrows a lodge's rule — and a
    // STALE column name is a Prisma validation error on every booking write path
    // that typecheck does not catch (the db parameter is a hand-written
    // `Pick<PrismaClient, ...>`). Read off the schema so the two cannot drift.
    const schema = readRepoFile("prisma/schema.prisma");
    const declared = [
      ...new Set(
        [...schema.matchAll(/^\s*(hostScope\w+)\s+Boolean\?/gm)].map(
          (match) => match[1],
        ),
      ),
    ].sort();
    expect(declared).toEqual([
      "hostScopeSameBooking",
      "hostScopeSameBookingOwner",
    ]);

    const loader = readRepoCode("src/lib/adult-member-hosting-review.ts");
    const select = loader.slice(
      loader.indexOf("adultMemberHostingPolicy.findMany({"),
    );
    const window = select.slice(0, select.indexOf("});"));
    for (const column of declared) {
      expect(window, column).toContain(`${column}: true,`);
    }
    // And nothing that is not declared: a column deleted from the schema but left
    // here is the same runtime failure in reverse.
    const selected = [...window.matchAll(/(hostScope\w+):\s*true/g)]
      .map((match) => match[1])
      .sort();
    expect(selected).toEqual(declared);
  });
});

describe("the school and organisation carve-out, and only that (#2569 §13)", () => {
  it("passes REVIEW_ONLY from exactly one place: the school and organisation request approval", () => {
    // One site, because there is one such approval: `BookingRequestType.SCHOOL`
    // carries school groups and organisations alike, and `approveSchoolBookingRequest`
    // is the only path that approves them. The owner's exclusion names school and
    // organisation REQUEST APPROVALS and nothing else, so a second site — a
    // member-owned flow quietly exempted — would be a policy change made by a
    // one-line argument rather than by a decision.
    expect(sourceFilesNaming('enforcement: "REVIEW_ONLY"')).toEqual([
      "src/lib/school-booking-request.ts",
    ]);
    const source = readRepoCode("src/lib/school-booking-request.ts");
    expect(source.match(/enforcement: "REVIEW_ONLY"/g) ?? []).toHaveLength(1);
    // And it is inside that approval rather than the MEMBER whole-lodge approval
    // further down the same file, which is deliberately not exempt (#2569 §2:
    // member-owned flows are in the first release; §13 is about teachers,
    // organisation leaders and custodians, none of which is a member booking the
    // whole lodge for their own party).
    const schoolApproval = source.indexOf(
      "export async function approveSchoolBookingRequest(",
    );
    const memberWholeLodge = source.indexOf(
      "export async function approveMemberWholeLodgeRequest(",
    );
    expect(schoolApproval).toBeGreaterThan(-1);
    expect(memberWholeLodge).toBeGreaterThan(schoolApproval);
    const site = source.indexOf('enforcement: "REVIEW_ONLY"');
    expect(site).toBeGreaterThan(schoolApproval);
    expect(site).toBeLessThan(memberWholeLodge);
    // The member whole-lodge approval still RECORDS the hazard; what changed is
    // that an enforcing lodge refuses it rather than approving into a review.
    expect(source.slice(memberWholeLodge)).toContain(
      "reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx)",
    );
  });

  it("keeps the general public request approval inside the refusal", () => {
    // A public booking request is an all-non-member party owned by a non-login
    // contact, which is precisely the booking an enforcing lodge has said it will
    // not take. It reconciles with no enforcement argument, so it refuses.
    const source = readRepoCode("src/lib/booking-request.ts");
    expect(source).toContain(
      "reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx)",
    );
    expect(source).not.toContain('enforcement: "REVIEW_ONLY"');
  });
});

describe("every refusing surface answers with something the caller can act on", () => {
  /**
   * Files that catch the refusal. Each must ALSO name the shape it answers with,
   * and the typed branch must come BEFORE any generic `ApiError` branch — the
   * refusal is a subclass, so below it the code, the frozen violation and the
   * exception door are all stripped.
   */
  const CATCHERS = sourceFilesNaming("instanceof AdultMemberHostingRequiredError");

  it("catches the refusal on every surface that can raise it, and nowhere else", () => {
    expect(CATCHERS).toEqual([
      "src/app/api/admin/booking-requests/[id]/approve/route.ts",
      "src/app/api/admin/booking-requests/[id]/hold/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
      "src/lib/group-booking.ts",
      "src/lib/waitlist-cross-lodge.ts",
      "src/lib/waitlist.ts",
    ]);
  });

  it("answers with the exception-door body, or with a deliberate exception to it", () => {
    // Three surfaces deliberately do NOT return the rich body, and each has a
    // reason in its own comment: the two officer-facing request paths ARE the
    // authority the door leads to, and the verified NON-MEMBER group join is
    // confirmed from an emailed token with no session, so a body naming the club's
    // settings would be a policy read for anyone holding a token.
    const OFFICER_PATHS = [
      "src/app/api/admin/booking-requests/[id]/approve/route.ts",
      "src/app/api/admin/booking-requests/[id]/hold/route.ts",
    ];
    for (const file of CATCHERS) {
      const source = readRepoCode(file);
      if (OFFICER_PATHS.includes(file)) {
        expect(source, file).toContain("code: err.code");
        expect(source, file).not.toContain("exceptionRequestPath");
        continue;
      }
      expect(source, file).toContain("buildAdultMemberHostingRefusalBody(");
    }
    // The public non-member join carries the generic sentence INSTEAD, on the one
    // file that also builds the redacted body for the member join beside it.
    const groupBooking = readRepoCode("src/lib/group-booking.ts");
    expect(groupBooking).toContain(
      "PUBLIC_GROUP_JOIN_ADULT_MEMBER_HOSTING_MESSAGE",
    );
  });

  it("puts the typed branch above the generic ApiError branch", () => {
    for (const file of CATCHERS) {
      const source = readRepoCode(file);
      const shared = sharedApiErrorName(source);
      if (shared === null) continue;
      const generic = source.indexOf(`instanceof ${shared}`);
      if (generic === -1) continue;
      const typed = source.indexOf("instanceof AdultMemberHostingRequiredError");
      expect(typed, file).toBeGreaterThan(-1);
      expect(typed, file).toBeLessThan(generic);
    }
  });

  it("uses the waitlist sentence on the waitlist paths and nowhere else", () => {
    // The extra fact it adds — "your offer has not been used" — is true only where
    // a claim was rolled back. On a booking path there is no offer behind it, so
    // the sentence would send the member looking for something they do not have.
    expect(
      sourceFilesNaming("formatAdultMemberHostingWaitlistRefusal"),
    ).toEqual([
      "src/lib/policies/adult-member-hosting.ts",
      "src/lib/waitlist-cross-lodge.ts",
      "src/lib/waitlist.ts",
    ]);
  });
});

describe("no policy read inside a booking transaction (#2569 §7)", () => {
  it("the create path evaluates the proposed party before the creating service runs", () => {
    // `evaluateProposedAdultMemberHosting` loads the policy rows and the party's
    // member facts. The transaction belongs to `booking-create.ts`, which the three
    // creating branches of this route call; doing the read inside it would hold the
    // per-lodge capacity lock while taking a second pool connection, which is the
    // shape the booking rules forbid outright, and would serialise every concurrent
    // booking at the lodge behind those reads. The refusal also has to come first
    // for a plainer reason: it is the only point where the member can be handed the
    // exception door with the party they actually submitted.
    const source = readRepoCode("src/app/api/bookings/route.ts");
    const evaluation = source.indexOf(
      "await evaluateProposedAdultMemberHosting(prisma, {",
    );
    expect(evaluation).toBeGreaterThan(-1);
    // The ENFORCED refusal sits with it, above every creating call.
    const refusal = source.indexOf(
      'hostingViolation?.consequence === "ENFORCED"',
    );
    expect(refusal).toBeGreaterThan(evaluation);

    const creators = [
      "createDraftBooking({",
      "createConfirmedBooking({",
      "createWaitlistedBooking({",
    ];
    for (const creator of creators) {
      const call = source.indexOf(creator);
      expect(call, creator).toBeGreaterThan(-1);
      expect(refusal, creator).toBeLessThan(call);
    }
    // ...and the transaction really is the service's, not this route's.
    expect(source).not.toContain("prisma.$transaction(");
    expect(readRepoCode("src/lib/booking-create.ts")).toContain(
      "prisma.$transaction(",
    );
  });

  it("the exception-request re-evaluation reads through its own client", () => {
    // The override door: a member refused by a booking path re-submits the party
    // here, and this re-evaluation is what reproduces the violation server-side.
    // It takes the caller's client rather than reaching for the module-level one.
    const source = readRepoFile("src/lib/booking-exception-request-service.ts");
    expect(source).toContain("evaluateProposedAdultMemberHosting(db, {");
  });

  it("the in-transaction reconcilers all pass the transaction client", () => {
    // The composition rule on `loadAdultMemberHostingPolicy`: a caller already
    // inside `prisma.$transaction` MUST pass its own `tx`, or the read checks out
    // a second connection underneath the advisory and capacity locks and sees a
    // different snapshot from the write it is about to decide.
    for (const file of sourceFilesNaming(
      "reconcileAdultMemberHostingReviewWithSiblings(",
    )) {
      if (file === "src/lib/adult-member-hosting-review.ts") continue;
      const source = readRepoFile(file);
      for (const call of source.matchAll(
        /reconcileAdultMemberHostingReviewWithSiblings\(\s*([^)]*)\)/g,
      )) {
        expect(call[1], `${file}: ${call[0]}`).toMatch(/,\s*tx\b/);
      }
    }
  });
});
