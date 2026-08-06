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
  it("resolves the club/lodge inheritance in exactly five places, none of them a booking path", () => {
    // The pure resolver (its own definition), the loader every booking write path
    // goes through, the admin card's effective view, the policy-change reconciler,
    // and the public booking-rules sentence. A booking path appearing here would be
    // a SECOND implementation of the inheritance rule — the thing §6 forbids by name.
    expect(sourceFilesNaming("resolveAdultMemberHostingPolicy(")).toEqual([
      "src/app/api/admin/booking-policies/adult-member-hosting/route.ts",
      "src/lib/adult-member-hosting-policy-reconciliation.ts",
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

describe("combined member refusal and officer queue contracts", () => {
  it("keeps every authoritative host-qualification writer on the durable seam", () => {
    for (const file of [
      "src/app/api/admin/members/bulk-update/route.ts",
      "src/lib/admin-member-detail-service.ts",
      "src/lib/member-guest-consent-service.ts",
      "src/lib/manual-subscription-payment.ts",
      "src/lib/xero-membership-sync.ts",
      "src/lib/member-merge.ts",
    ]) {
      const source = readRepoCode(file);
      expect(source, file).toContain(
        "enqueueHostingCoverageReevaluationForMember(",
      );
      expect(source, file).toContain("settleHostingCoverageAfterCommit(");
    }
    expect(readRepoCode("src/lib/member-merge.ts")).toContain(
      "enqueueOwnHostingCoverageReevaluation(",
    );
  });

  it("returns both paid-up and hosting reasons through the redacted refusal shape", () => {
    for (const file of [
      "src/app/api/bookings/route.ts",
      "src/lib/group-booking.ts",
    ]) {
      const source = readRepoCode(file);
      expect(source, file).toContain(
        'code: "BOOKING_POLICY_REQUIREMENTS_NOT_MET"',
      );
      expect(source, file).toContain("reasonCodes:");
      expect(source, file).toMatch(
        /const hostingRefusal\s*=\s*buildAdultMemberHostingRefusalBody\(hostingViolation\)/,
      );
      expect(source, file).toContain("...hostingRefusal.violations");
      expect(source, file).toContain(
        "exceptionRequestPath: hostingRefusal.exceptionRequestPath",
      );
    }
  });

  it("puts unresolved incidents in the bookings permission area with direct rows", () => {
    const page = readRepoCode("src/app/(admin)/admin/bookings/page.tsx");
    expect(page).toContain('id="hosting-coverage-incidents"');
    expect(page).toContain("prisma.hostingCoverageIncident.count(");
    expect(page).toContain("prisma.hostingCoverageIncident.findMany(");
    expect(page.match(/resolvedAt:\s*null/g)).toHaveLength(2);
    expect(
      page.match(/\.\.\.\(query\.lodgeId \? \{ lodgeId: query\.lodgeId \} : \{\}\)/g),
    ).toHaveLength(2);
    expect(page).toContain("`/bookings/${incident.bookingId}`");

    const permissions = readRepoCode("src/lib/admin-permissions.ts");
    expect(permissions).toContain('area: "bookings"');
    expect(permissions).toContain('"/admin/bookings"');
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
    // TWO files, and the second is not a second carve-out. #2576's post-commit
    // coverage drain re-evaluates a booking that is ALREADY confirmed, so there is
    // nothing left to refuse — throwing there would abort a background sweep and
    // roll back the very incident it exists to record. It lives inside the review
    // service itself rather than at a flow, and the position assertion below pins
    // it to that one function, so it cannot become a way for a booking path to opt
    // out of an enforcing club's rule.
    expect(sourceFilesNaming('enforcement: "REVIEW_ONLY"')).toEqual([
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/school-booking-request.ts",
    ]);
    const reviewService = readRepoCode("src/lib/adult-member-hosting-review.ts");
    expect(
      reviewService.match(/enforcement: "REVIEW_ONLY"/g) ?? [],
    ).toHaveLength(1);
    const incidentReconciler = reviewService.indexOf(
      "export async function reconcileSameOwnerCoverageIncident(",
    );
    expect(incidentReconciler).toBeGreaterThan(-1);
    expect(
      reviewService.indexOf('enforcement: "REVIEW_ONLY"'),
    ).toBeGreaterThan(incidentReconciler);
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
      // #2576 §9: confirming a DRAFT is a confirmation, and DRAFT is outside
      // `ACTIVE_BOOKING_STATUSES` — so it is invisible to the strand check that
      // guards a source cancellation, and this was the one confirming path where an
      // uncovered booking could reach PAID deterministically rather than by a race.
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
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

describe("the same-owner refusal and the escalation seam (#2576 §6, §8, §9)", () => {
  const REFUSAL_CATCHERS = sourceFilesNaming(
    "instanceof SameOwnerCoverageWouldBreakError",
  );

  it("catches the same-owner refusal on every member self-service surface", () => {
    // The five change classes §6 names that a member can reach: cancelling,
    // removing a guest, adding guests (which moves the night picture), a date
    // change and a batch edit. A path that raises it and does not catch it answers
    // a bare 409 with no list of the member's own affected bookings — which is the
    // whole content of the message.
    expect(REFUSAL_CATCHERS).toEqual([
      "src/app/api/bookings/[id]/cancel/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
    ]);
  });

  it("answers with the structured body, above any generic ApiError branch", () => {
    // Same positional trap as its #2569 sibling: `SameOwnerCoverageWouldBreakError`
    // extends `ApiError`, so below a generic branch the member loses the booking
    // references, the lodge and the uncovered nights.
    for (const file of REFUSAL_CATCHERS) {
      const source = readRepoCode(file);
      expect(source, file).toContain("buildSameOwnerCoverageRefusalBody(");
      const shared = sharedApiErrorName(source);
      if (shared === null) continue;
      const generic = source.indexOf(`instanceof ${shared}`);
      if (generic === -1) continue;
      expect(
        source.indexOf("instanceof SameOwnerCoverageWouldBreakError"),
        file,
      ).toBeLessThan(generic);
    }
  });

  it("returns the state-bound override prompt from every officer-capable catcher", () => {
    const catchers = sourceFilesNaming(
      "instanceof SameOwnerCoverageOverrideRequiredError",
    );
    expect(catchers).toEqual([
      "src/app/api/admin/booking-exception-requests/[id]/route.ts",
      "src/app/api/bookings/[id]/cancel/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
    ]);
    for (const file of catchers) {
      expect(readRepoCode(file), file).toContain(
        "buildSameOwnerCoverageOverrideRequiredBody(",
      );
    }
  });

  it("threads the state-bound retry through both admin shift dispatchers", () => {
    for (const file of [
      "src/app/api/bookings/[id]/modify/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
    ]) {
      const source = readRepoCode(file);
      const shift = source.slice(source.indexOf("await adminShiftBookingDates({"));
      expect(shift, file).toMatch(
        /adminShiftBookingDates\(\{[\s\S]*?hostingCoverageOverride:\s*parsed\.data\.hostingCoverageOverride/,
      );
    }
    const service = readRepoCode("src/lib/booking-date-modification-service.ts");
    const shiftService = service.slice(
      service.indexOf("export async function adminShiftBookingDates("),
    );
    expect(shiftService).toContain("actorMemberId: actor.id");
    expect(shiftService).toContain("override: hostingCoverageOverride");
  });

  it("uses the enqueue-only seam on exactly the confirming paths that must not refuse", () => {
    // §9 requires every confirming path to re-read the hosting facts. Most do it by
    // reconciling inside their own transaction, which REFUSES an uncovered booking at
    // an enforcing club. These cannot: capacity is claimed and money is in flight or
    // settled, so §8 applies instead — allow the transition, record the bounded
    // re-evaluation with it, escalate to an urgent incident afterwards.
    //
    // THIS LIST GREW BECAUSE THE FIRST VERSION OF IT WAS WRONG. It named five files
    // and read as though that were the whole confirming set, but the assertion only
    // pins who USES the seam — it cannot see a confirming path that uses NEITHER
    // seam, and five of them did not: the single payment settle door (whose payable
    // set includes DRAFT), the fully-credit-covered settlement, the inbound Xero
    // PAID, the admin waitlist force-confirm, and the group-settlement reaper's
    // CONFIRMED -> PAYMENT_PENDING revert, which de-confirms a coverage SOURCE.
    // `confirmingPathsUseAHostingSeam` below is the assertion that actually closes
    // that hole.
    expect(sourceFilesNaming("enqueueOwnHostingCoverageReevaluation(")).toEqual([
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
      "src/app/api/admin/bookings/[id]/force-confirm/route.ts",
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
      "src/app/api/payments/switch-to-internet-banking/route.ts",
      "src/lib/adult-member-hosting-review.ts",
      "src/lib/booking-credit-election.ts",
      "src/lib/cron-confirm-pending.ts",
      "src/lib/cron-group-settlement-reaper.ts",
      "src/lib/group-settlement.ts",
      "src/lib/member-merge.ts",
      "src/lib/payment-reconciliation.ts",
      "src/lib/xero-inbound/invoice-paid-effects.ts",
    ]);
  });

  it("leaves no confirming write without a hosting seam at all (#2576 §9)", () => {
    // The assertion the census above could not make. Every file that claims a
    // booking into a confirmed-or-paid state must reach the hosting rule by one of
    // the two seams — reconcile (refuse) or enqueue (escalate) — because §9 forbids
    // relying on a quote-time answer, and the statuses these writes come FROM
    // (DRAFT, WAITLISTED, WAITLIST_OFFERED, PAYMENT_PENDING) are all outside
    // `ACTIVE_BOOKING_STATUSES` and therefore invisible to the strand check that
    // guards a source cancellation. A booking could be created while cover existed,
    // have that cover cancelled with nothing stranded and nothing queued, and then
    // confirm here with no refusal, no incident, no owner email and nothing in the
    // officer queue.
    const CONFIRMING_WRITES = [
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
      "src/app/api/admin/bookings/[id]/force-confirm/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
      "src/app/api/payments/switch-to-internet-banking/route.ts",
      "src/lib/booking-credit-election.ts",
      "src/lib/cron-confirm-pending.ts",
      "src/lib/group-settlement.ts",
      "src/lib/payment-reconciliation.ts",
      "src/lib/waitlist.ts",
      "src/lib/xero-inbound/invoice-paid-effects.ts",
    ];
    for (const file of CONFIRMING_WRITES) {
      const source = readRepoCode(file);
      const usesASeam =
        source.includes("enqueueOwnHostingCoverageReevaluation(") ||
        source.includes("reconcileAdultMemberHostingReviewWithSiblings(");
      expect(usesASeam, file).toBe(true);
    }
  });

  /**
   * The files that DEFINE the enqueue seams, plus the transaction-scoped helpers that
   * run inside somebody else's `tx` and so have no commit of their own to drain
   * after. Every other name reached by the sweep below would be a real gap.
   *
   * Shared by the two assertions that follow, because the exemption and the proof of
   * its premise have to be reading the same list — a helper exempted in one place and
   * unproven in the other is how the `member-guest-consent-service.ts` gap survived.
   */
  const TX_SCOPED_HELPERS = [
    "src/lib/adult-member-hosting-review.ts",
    "src/lib/booking-credit-election.ts",
    "src/lib/booking-guest-removal-service.ts",
    "src/lib/booking-exception-approval.ts",
  ];

  it("drains after the commit on every path that can record work", () => {
    // A queue row with nobody draining it is §7's "immediate re-evaluation" turned
    // into "within three hours": that long before an incident a new officer-created
    // booking has just fixed is resolved, or before one it caused is raised.
    //
    // TREE-WIDE, WHICH IS WHAT THE FIRST VERSION OF THIS TEST ONLY LOOKED LIKE. It
    // swept the enqueue users and then checked a HARDCODED list of five change
    // paths, so five other files that reconcile — and therefore can enqueue, because
    // `dependentCoverage` defaults to ESCALATE — sat outside the assertion entirely:
    // waitlist.ts, booking-request.ts, booking-request-quotes.ts, group-booking.ts
    // and school-booking-request.ts. The sweep below finds them by what they CALL.
    const ENQUEUE_SEAMS = [
      "enqueueOwnHostingCoverageReevaluation(",
      "enqueueHostingCoverageReevaluationForMember(",
      "reconcileAdultMemberHostingReviewWithSiblings(",
    ];
    const seamUsers = new Set<string>();
    for (const seam of ENQUEUE_SEAMS) {
      for (const file of sourceFilesNaming(seam)) seamUsers.add(file);
    }
    for (const file of [...seamUsers].sort()) {
      if (TX_SCOPED_HELPERS.includes(file)) continue;
      expect(readRepoCode(file), file).toContain(
        "settleHostingCoverageAfterCommit(",
      );
    }
  });

  it("proves the carve-out's premise: every caller of a tx-scoped helper drains", () => {
    // THE CARVE-OUT ABOVE ASSERTS SOMETHING IT DOES NOT CHECK, and that unchecked
    // half is where a real gap hid. `booking-guest-removal-service.ts` is exempt on
    // the stated grounds that "its own callers drain" — and one of them did not:
    // `member-guest-consent-service.ts` routes a DECLINE and an EXPIRY through the
    // shared removal path, which reconciles and can enqueue, and then committed
    // without draining. §6 lists "removal or decline of required member-guest
    // consent" among the changes that must be re-evaluated, so the owner of a booking
    // that had just lost its cover waited up to three hours to be told.
    //
    // So the premise is now an assertion. A future helper added to the exempt list
    // brings its callers into this sweep automatically, which is the property the
    // hardcoded list never had.
    const EXPORTED_TX_ENTRYPOINTS: Record<string, readonly string[]> = {
      "src/lib/booking-guest-removal-service.ts": [
        "removeBookingGuestInTransaction(",
      ],
      "src/lib/booking-credit-election.ts": ["settleFullyCreditCoveredBooking("],
      "src/lib/booking-exception-approval.ts": [],
      // The seam definitions themselves; their callers are the sweep above.
      "src/lib/adult-member-hosting-review.ts": [],
    };
    for (const helper of TX_SCOPED_HELPERS) {
      const entrypoints = EXPORTED_TX_ENTRYPOINTS[helper];
      // A helper added to the exempt list without saying how it is entered would
      // silently opt its callers out of the whole invariant.
      expect(entrypoints, `${helper} has no declared entrypoints`).toBeDefined();
      for (const entrypoint of entrypoints ?? []) {
        for (const caller of sourceFilesNaming(entrypoint)) {
          if (caller === helper) continue;
          expect(
            readRepoCode(caller),
            `${caller} calls ${entrypoint} and must drain after its commit`,
          ).toContain("settleHostingCoverageAfterCommit(");
        }
      }
    }
  });

  it("never drains through a transaction client", () => {
    // The drain takes the module client by default. A call that handed it a `tx`
    // would read the uncommitted rows it exists to re-read, and would send email
    // from a transaction that can still roll back.
    for (const file of sourceFilesNaming("settleHostingCoverageAfterCommit(")) {
      const source = readRepoCode(file);
      for (const call of source.matchAll(
        /settleHostingCoverageAfterCommit\(([^)]*)\)/g,
      )) {
        // The argument is a scoping object (`{ bookingId }`, `{ limit }`) — never a
        // client. `\btx\b` still catches the mistake this exists to catch, because a
        // transaction client is only ever named `tx` here.
        expect(call[1].trim(), `${file}: ${call[0]}`).not.toMatch(/\btx\b/);
      }
    }
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

  it("every proposed-booking evaluator carries the authoritative Booking.memberId", () => {
    const create = readRepoCode("src/app/api/bookings/route.ts");
    expect(create).toContain("bookingOwnerMemberId: effectiveMemberId");

    const groupJoin = readRepoFile("src/lib/group-booking.ts");
    expect(groupJoin).toContain("bookingOwnerMemberId: sessionUserId");

    const exceptionRequest = readRepoFile(
      "src/lib/booking-exception-request-service.ts",
    );
    expect(exceptionRequest).toContain(
      "bookingOwnerMemberId = await resolveProposalBookingOwner(db, presence)",
    );
    expect(exceptionRequest).toContain("bookingOwnerMemberId,");
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

  it("keeps the ENFORCED modification bypass exclusive to an approved exception", () => {
    // This option carries a prior attributable officer decision into the real
    // batch service, so it suppresses the ordinary ENFORCED refusal. A route or
    // another service copying it would create an unreviewed bypass even though
    // the implementation still typechecks. Pin both its declaration and its sole
    // supplier tree-wide.
    expect(
      sourceFilesNaming("approvedExceptionAdultMemberHostingDecision"),
    ).toEqual([
      "src/lib/booking-batch-modification-service.ts",
      "src/lib/booking-exception-approval.ts",
    ]);

    expect(readRepoCode("src/lib/booking-batch-modification-service.ts")).toMatch(
      /approvedExceptionAdultMemberHostingDecision\?:\s*\{[\s\S]*?reason:\s*string;[\s\S]*?byMemberId:\s*string;/,
    );
    expect(readRepoCode("src/lib/booking-exception-approval.ts")).toContain(
      "approvedExceptionAdultMemberHostingDecision:",
    );
  });
});
