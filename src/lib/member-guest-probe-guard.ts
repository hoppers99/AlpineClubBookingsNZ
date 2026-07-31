import { createStructuredAuditLog, getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  applyMemberScopedRateLimit,
  rateLimiters,
} from "@/lib/rate-limit";

/**
 * The three mitigations the owner decided on #2388 (31 Jul 2026), applied to
 * every member-facing booking ADD PATH — and not only to MG3's new find routes.
 *
 * THE SIX PATHS, listed because the list was wrong when it was first written and
 * the omission was a real hole (privacy review of MG3 #2308, finding H2):
 *
 *   * `POST /api/bookings/quote`            — throttled at the boundary hook
 *   * `POST /api/bookings`                  — throttled at the boundary hook
 *   * `POST /api/bookings/[id]/modify-quote`— boundary hook AND whole-party charge
 *   * `POST /api/bookings/[id]/guests`      — charged on the refusal path
 *   * `PUT  /api/bookings/[id]/modify`      — charged on the refusal path
 *   * `PUT  /api/bookings/[id]/modify-dates`— charged on the refusal path
 *
 * `bookings/[id]/modify` is the one that was missed. `addGuests` is in its
 * schema, any authenticated member reaches it, and `booking-modify-plan.ts`
 * passes `memberGuestWideningEnabled`, so cross-family adds genuinely resolve
 * there — with no throttle, no `member_guest.add_refused` row (so the
 * admin-visible repeated-refusal signal was blind to the route entirely) and no
 * timing floor. `modify-dates` joined the list when MG3's C1 fix made the
 * collapsed refusal reachable there too.
 *
 * AND `modify-quote` NEEDS TWO CHARGE POINTS, NOT ONE (privacy re-review of MG3
 * #2308, finding HIGH-1). The boundary hook counts an attempt that NAMES a
 * beyond-family member, and the C1 read-out is reachable with `addGuests` EMPTY:
 * with no ids to resolve, `resolveLinkedBookingMembersWithBoundary` returns
 * before the boundary is computed, so the hook never runs, and
 * `applyMemberGuestAddThrottle` would return null for the empty set even if it
 * did. The refusal that follows is raised much later, by the person-night guard
 * reading the marker `markCrossFamilyGuestsOnBooking` just derived — audited and
 * floored, but costing nothing. That left the CHEAPEST surface in the product
 * uncapped: one preview per date range, ~150 of them to sweep a season.
 * `applyMemberGuestPartyProbeThrottle` closes it by charging over the whole
 * proposed party the moment the marker is known, and `MemberGuestAddThrottleLedger`
 * is what stops the two charge points from billing the same request twice.
 *
 * The last three resolve their members INSIDE `prisma.$transaction` while holding
 * the per-lodge capacity lock, so the throttle cannot be spent on the way in
 * without taking a second connection under that lock. They spend it on the way
 * out instead — see `handleMemberGuestAddRefusal`, whose `throttle` parameter
 * makes which of the two a route is doing an explicit, unforgettable decision.
 *
 * WHAT #2388 IS ABOUT, in one paragraph, because the mitigations only make sense
 * against it. D-8 collapses every cross-family refusal to one neutral sentence,
 * so a SINGLE refusal says nothing. But the refusal depends on the DATES asked
 * about, so a member who repeats the question across a run of dates and writes
 * down which attempts fail can map the nights that other member is already
 * booked on — at any lodge, because the person-night rule is club-wide. Uniform
 * wording removes the label from each answer; it does not remove the signal in
 * the PATTERN of answers.
 *
 * THE THREE MITIGATIONS, and what each one actually buys:
 *
 *  1. `applyMemberGuestAddThrottle` — per-ACTING-MEMBER throttling, counted only
 *     on attempts that involve a beyond-family member. At 50 a day a ~150-night
 *     season is about three days' work and a whole year about seven and a half,
 *     so this turns a scripted afternoon into days — it does NOT make mapping
 *     infeasible, and nothing here may claim that it does. What it buys besides
 *     the delay is up to fifty audit rows a day naming the prober and the target.
 *  2. `equaliseMemberGuestRefusalTiming` — a response floor on the collapsed
 *     refusal, so "there is no such member" stops being the fast one. Paired with
 *     a body fix in `booking-guests.ts`, because timing was never the only tell:
 *     the not-found case answered with a DIFFERENT message and status until this
 *     change.
 *  3. `recordMemberGuestAddRefusal` — every collapsed refusal is written to the
 *     audit trail naming the actor and the target, and a run of them against the
 *     same target raises a distinct, severity-important row an admin can find.
 *
 * WHAT MITIGATION 3 DELIBERATELY IS NOT. The owner's explicit sub-decision:
 * **log for admins only, never refuse outright.** A member trying several dates
 * to find one that suits a friend is the normal, innocent case, and blocking
 * them would produce a deliberately vague refusal they could not act on. So
 * nothing in this module branches on the repeat count — `recordMemberGuestAddRefusal`
 * returns `void`, its callers ignore it, and its failure is swallowed. A club
 * officer handles genuine probing as a people problem. `member-guest-probe-guard.test.ts`
 * pins that property directly by running a long refused sequence and asserting
 * every answer is byte-identical to the first.
 *
 * (The throttle in mitigation 1 is a different animal and was separately decided:
 * it counts ATTEMPTS rather than refusals, is not keyed on the target, clears
 * itself, and never becomes permanent.)
 */

// ---------------------------------------------------------------------------
// 1. Per-acting-member throttling on the add paths
// ---------------------------------------------------------------------------

/**
 * ONE throttle unit per REQUEST, however many places in that request could spend
 * it (privacy re-review of MG3 #2308, finding HIGH-1).
 *
 * `modify-quote` has two places that must be able to charge — the boundary hook,
 * for an attempt that NAMES a beyond-family member, and the whole-party charge,
 * for a preview that merely CARRIES one — and on a request that does both they
 * are the same attempt. Charging twice is not a rounding error: an earlier
 * version of the refusal handler double-charged and silently halved the
 * advertised budget from 15/50 to ~7/25, which came out of the owner's
 * explicitly protected honest case (somebody trying five weekends for a friend)
 * as much as out of the prober's.
 *
 * Deliberately a plain mutable object rather than anything cleverer: it is
 * created at the top of a handler, passed down, and dies with the request. There
 * is no cross-request state and nothing to clean up.
 */
export type MemberGuestAddThrottleLedger = { spent: boolean };

export function createMemberGuestAddThrottleLedger(): MemberGuestAddThrottleLedger {
  return { spent: false };
}

/**
 * Throttle a booking add/quote attempt that names at least one beyond-family
 * member. Returns a 429 `Response` when the actor's budget is spent, else null.
 *
 * CALLED ONLY WHEN THE ATTEMPT IS ACTUALLY CROSS-FAMILY. That is the design, not
 * an optimisation: a family booking must not become rate-limited by a privacy
 * mitigation aimed at a different behaviour, however many times the booker
 * changes their dates. It also means the counter measures exactly the thing
 * #2388 describes.
 *
 * ADMIN ON-BEHALF PATHS ARE EXEMPT. A booking officer adding a member to
 * somebody's booking is doing their job through a `skipAuthorization` path, has
 * legitimate access to the member's whole record anyway, and would be the first
 * person to hit a fifteen-per-quarter-hour cap on a busy morning. Throttling them
 * would buy nothing: the correlation channel exists because a member can learn
 * something they are not entitled to, and an officer is entitled to it.
 *
 * Two windows, checked in order: the burst window first (cheap, catches a script),
 * then the daily backstop (what actually defeats mapping a season).
 */
export async function applyMemberGuestAddThrottle(params: {
  request: Request;
  actorMemberId: string;
  beyondFamilyMemberIds: readonly string[];
  /** True on an admin/officer on-behalf path — exempt, see above. */
  skipAuthorization?: boolean;
  /**
   * Optional per-request ledger. When supplied, the unit is spent at most once
   * per request however many charge points fire — see the ledger's own note.
   */
  ledger?: MemberGuestAddThrottleLedger;
}): Promise<Response | null> {
  const { request, actorMemberId, beyondFamilyMemberIds, skipAuthorization, ledger } =
    params;

  if (skipAuthorization) return null;
  if (beyondFamilyMemberIds.length === 0) return null;
  if (!actorMemberId) return null;
  if (ledger?.spent) return null;

  // Marked BEFORE the awaits: the unit is now this request's, whatever the
  // limiter answers. Marking it afterwards would let two concurrent charge
  // points inside one request both see `spent === false` and both charge.
  if (ledger) ledger.spent = true;

  const burst = await applyMemberScopedRateLimit(
    rateLimiters.memberGuestAddProbe,
    request,
    actorMemberId,
  );
  if (burst) return burst;

  return applyMemberScopedRateLimit(
    rateLimiters.memberGuestAddProbeDaily,
    request,
    actorMemberId,
  );
}

/**
 * The whole-party charge: spend this request's unit because the PROPOSED PARTY
 * carries a beyond-family member guest, whether or not this request named one.
 *
 * WHY A SECOND CHARGE POINT EXISTS (privacy re-review of MG3 #2308, HIGH-1).
 * `applyMemberGuestAddThrottle` counts attempts that NAME a beyond-family member,
 * which is the right unit for an add. It is the wrong unit for `modify-quote`,
 * whose C1 exposure is reachable with `addGuests` EMPTY: the member guest is
 * already on the booking, the request only moves the dates, and every such
 * preview asks the person-night guard a fresh question about that member's
 * occupancy. With an empty id list the boundary is never computed, the hook
 * never fires, and the run costs nothing at all — one request per date range,
 * held only by the 250 ms floor.
 *
 * CHARGED ON EVERY SUCH REQUEST, REFUSED OR NOT, and that is the point. Charging
 * only on the refusal would leave the "no clash" answer free, and the free answer
 * carries exactly as much of the calendar as the refused one: a prober would pay
 * only for the nights the target IS booked, which is the cheap half of the sweep.
 *
 * SAFE TO ANSWER 429 FROM HERE. The set is derived from the booker's OWN booking
 * and their OWN family groups — nothing has been read about the target, and the
 * answer does not vary with anything about them. It is the same position as the
 * boundary hook, which is why the two share a budget rather than a branch.
 *
 * THE COST TO THE HONEST BOOKER IS REAL AND WAS ACCEPTED. Someone re-dating a
 * booking that carries a member guest now spends a unit per preview, so a long
 * fiddling session can hit the burst cap. The 500 ms debounce and the edit
 * panel's own quote suppression keep an ordinary edit well inside 15; the same
 * trade already applied to the wizard, where every re-quote after adding a member
 * guest charges at the hook.
 */
export async function applyMemberGuestPartyProbeThrottle(params: {
  request: Request;
  actorMemberId: string;
  /** The party AFTER `markCrossFamilyGuestsOnBooking` has re-derived the marker. */
  guests: ReadonlyArray<{
    memberId?: string | null;
    crossFamilyMemberGuest?: boolean;
  }>;
  skipAuthorization?: boolean;
  ledger: MemberGuestAddThrottleLedger;
}): Promise<Response | null> {
  const beyondFamilyMemberIds = [
    ...new Set(
      params.guests
        .filter((guest) => guest.crossFamilyMemberGuest === true)
        .map((guest) => guest.memberId?.trim())
        .filter((memberId): memberId is string => Boolean(memberId)),
    ),
  ];

  return applyMemberGuestAddThrottle({
    request: params.request,
    actorMemberId: params.actorMemberId,
    beyondFamilyMemberIds,
    skipAuthorization: params.skipAuthorization,
    ledger: params.ledger,
  });
}

/**
 * The throttle's 429, thrown so it can be raised from inside member resolution.
 *
 * The routes cannot simply call `applyMemberGuestAddThrottle` before resolving,
 * because the boundary it needs is computed INSIDE
 * `resolveLinkedBookingMembersWithBoundary`. Passing the check in as a hook and
 * throwing the response out is what lets the budget be spent before anything at
 * all has been read about the member — see `memberGuestAddThrottleHook`.
 */
export class MemberGuestAddThrottledError extends Error {
  constructor(public readonly response: Response) {
    super("Member-guest add attempt throttled");
    this.name = "MemberGuestAddThrottledError";
  }
}

/**
 * The `onBoundaryResolved` hook every member-facing add path passes to
 * `resolveLinkedBookingMembersWithBoundary`.
 *
 * ORDERING IS THE WHOLE POINT (privacy review of MG3 #2308, finding H1). Applied
 * AFTER resolution — where it used to live — the throttle answered 429 for a
 * real bookable member and 403 for a non-existent, inactive or age-exempt one,
 * because resolution throws first for the latter and the refusal handler
 * deliberately discards its 429. That is an existence oracle built out of the
 * mitigation, and `member-guest-probe-guard`'s own docblock claimed the opposite.
 * Applied here, before a single member row is read, both answer 429.
 */
export function memberGuestAddThrottleHook(params: {
  request: Request;
  actorMemberId: string;
  skipAuthorization?: boolean;
  /**
   * Shared with any later charge point in the same request (`modify-quote`'s
   * whole-party charge), so one attempt costs one unit — see
   * `MemberGuestAddThrottleLedger`.
   */
  ledger?: MemberGuestAddThrottleLedger;
}): (boundary: { beyondFamilyMemberIds: readonly string[] }) => Promise<void> {
  return async (boundary) => {
    const throttled = await applyMemberGuestAddThrottle({
      request: params.request,
      actorMemberId: params.actorMemberId,
      beyondFamilyMemberIds: boundary.beyondFamilyMemberIds,
      skipAuthorization: params.skipAuthorization,
      ledger: params.ledger,
    });
    if (throttled) {
      throw new MemberGuestAddThrottledError(throttled);
    }
  };
}

// ---------------------------------------------------------------------------
// 2. Response-timing equalisation on the neutral refusal
// ---------------------------------------------------------------------------

/**
 * The floor every collapsed cross-family refusal is held to, in milliseconds.
 *
 * 250 ms covers the EARLY collapse sites outright: boundary resolution, the
 * member-record read and the profile gate's two parallel reads all finish well
 * inside it, so the fastest refusal of all — the one that used to give up after
 * a single query — is no longer the fast one.
 *
 * IT IS A MINIMUM, NOT A BUDGET, AND ON `modify-quote` THAT MATTERS (privacy
 * re-review of MG3 #2308, MEDIUM-3). That route's later collapse sites — the
 * person-night guard and the unpaid-subscription check — fire only after the
 * booking, its guests, their nights, the promo, the season rates, the default
 * lodge, the lodge capacity, the whole-party marking and the membership-type
 * resolve have all been read. On a real booking that work can exceed 250 ms by
 * itself, and when it does the floor adds nothing and the two GROUPS of refusals
 * are separable by stopwatch again: "resolution or profile" answers at the
 * floor, "already booked those nights or subscription unpaid" answers at
 * whatever the pricing path cost.
 *
 * RAISING THE NUMBER WAS CONSIDERED AND REJECTED. A floor high enough to cover
 * the slowest pricing path on the slowest deployment would have to be seconds,
 * and it applies to the honest booker's refusal as much as the prober's — a
 * member adding a friend who turns out to be unpaid would wait that long to be
 * told "not right now". #2388's answer to the residual is the throttle and the
 * audit trail, both of which act on the run rather than the single answer; the
 * floor's job is only to kill the free, single-query measurement, and at 250 ms
 * it does that.
 *
 * So what this constant guarantees is: no collapsed refusal returns in less than
 * 250 ms. It does NOT guarantee that all collapsed refusals return in the same
 * time. `equaliseMemberGuestRefusalTiming` says the same thing at more length.
 */
export const MEMBER_GUEST_REFUSAL_FLOOR_MS = 250;

/**
 * Start the refusal-timing clock. Call this at the TOP of an add-path handler
 * and pass the result to `equaliseMemberGuestRefusalTiming`.
 *
 * MONOTONIC, NOT THE WALL CLOCK, and both halves of that matter.
 *
 * Correctness: this measures a DURATION, and `Date.now()` is not a duration
 * clock. An NTP correction mid-request can make a wall-clock delta negative or
 * enormous, which would either skip the floor entirely or hang the response.
 * `performance.now()` cannot go backwards.
 *
 * Contract: `review-findings-contracts.test.ts` forbids `Date.now()` outright in
 * `api/bookings/[id]/modify`, `modify-dates` and `guests` — booking-modification
 * idempotency keys must never be derived from the clock, or a retry mints a
 * fresh Stripe key and the idempotency guarantee is gone. That contract is a
 * blunt source grep BY DESIGN: it cannot tell a benign clock read from a
 * dangerous one, and it should not try. So the add paths do not read a clock at
 * all — they call this, whose name says what the number is for. Anything built
 * from a value called "the refusal timing clock" is visibly wrong at the call
 * site, which is the property the grep was protecting.
 *
 * BRANDED, so a wall-clock reading cannot be passed by accident (privacy review
 * of MG3 #2308, finding L4). `equaliseMemberGuestRefusalTiming` subtracts this
 * value from `performance.now()`; hand it a `Date.now()` reading and the delta
 * is a vast negative number, the computed delay clamps to zero, and the floor
 * SILENTLY DOES NOT APPLY — a privacy control failing open with no error and no
 * test failure. The brand makes that a compile error at the call site, and the
 * range check in `memberGuestRefusalDelayMs` catches anything that reaches it
 * anyway.
 */
export type MemberGuestRefusalClock = number & {
  readonly __memberGuestRefusalClock: unique symbol;
};

export function startMemberGuestRefusalClock(): MemberGuestRefusalClock {
  return performance.now() as MemberGuestRefusalClock;
}

let refusalFloorMs = MEMBER_GUEST_REFUSAL_FLOOR_MS;

// test seam — lets the route tests exercise the real refusal path without
// spending a quarter of a second per assertion. Never called from src/app.
export function __setMemberGuestRefusalFloorMs(ms: number): void {
  refusalFloorMs = ms;
}

/**
 * How long a refusal that has already taken `elapsedMs` must still wait.
 *
 * FAILS CLOSED ON AN IMPOSSIBLE ELAPSED TIME. A negative delta, or one longer
 * than any request could plausibly take, means the caller measured against the
 * wrong clock — and the arithmetic's natural answer to that is "wait zero", i.e.
 * skip the control entirely. Applying the WHOLE floor instead costs a quarter of
 * a second on a refusal and cannot leak anything.
 */
const IMPLAUSIBLE_ELAPSED_MS = 10 * 60 * 1000;

export function memberGuestRefusalDelayMs(elapsedMs: number): number {
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > IMPLAUSIBLE_ELAPSED_MS
  ) {
    return refusalFloorMs;
  }
  return Math.max(0, refusalFloorMs - elapsedMs);
}

/**
 * Hold a collapsed refusal until it has taken at least the floor.
 *
 * HONEST ABOUT WHAT THIS BUYS, because an overclaim here is how somebody later
 * builds on a guarantee that was never made. A fixed floor NARROWS the timing
 * channel; it does not close it. Anything slower than the floor still reports its
 * own duration, so a refusal that happens to run long — a cold cache, a contended
 * lock — is still distinguishable from one that finished in 20 ms and waited. What
 * the floor does remove is the CHEAP, reliable version of the measurement: the
 * "no such member" answer used to come back in a single query's time, every time,
 * and now it does not.
 *
 * The body fix that ships alongside it matters more. Until this change the
 * not-found case answered with a different MESSAGE and a different STATUS
 * (400 "Linked member is inactive or not found" against the neutral 403), so no
 * timing measurement was needed at all. `booking-guests.ts` now collapses that
 * case for beyond-family ids, and this floor is what stops the collapse being
 * undone by a stopwatch.
 *
 * `startedAt` is a `startMemberGuestRefusalClock()` reading taken at the TOP of
 * the route handler, passed in rather than read here so the floor covers the
 * whole request rather than only the part after the failure was detected.
 */
export async function equaliseMemberGuestRefusalTiming(
  startedAt: MemberGuestRefusalClock,
  now: number = performance.now(),
): Promise<void> {
  const delay = memberGuestRefusalDelayMs(now - startedAt);
  if (delay <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

// ---------------------------------------------------------------------------
// 3. Logging repeated refusals against the same target — for admins, never a block
// ---------------------------------------------------------------------------

/** The audit action every collapsed cross-family refusal writes. */
export const MEMBER_GUEST_REFUSAL_AUDIT_ACTION = "member_guest.add_refused";

/**
 * The audit action a RUN of refusals against one target raises, distinctly.
 *
 * A distinct action with `severity: "important"` is what makes the pattern findable:
 * an admin scanning the audit log sees one warning row saying "this member has now
 * been refused N times against this same other member", rather than having to
 * notice the shape of fifty identical `add_refused` rows.
 *
 * ONE ROW PER ACTOR/TARGET PER WINDOW. It fires on the CROSSING, not on every
 * refusal past it — see the check in `recordMemberGuestAddRefusal`.
 */
export const MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION =
  "member_guest.repeated_refusal";

/** How many refusals against ONE target, inside the window, raise the warning row. */
export const MEMBER_GUEST_REPEATED_REFUSAL_THRESHOLD = 5;

/** The window the threshold is counted over. */
export const MEMBER_GUEST_REPEATED_REFUSAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Record that a cross-family member-guest add was refused, and raise a warning
 * row when the same actor has now been refused repeatedly against the same
 * target.
 *
 * ONE ROW PER TARGET PER REFUSAL. The actor is the booker, the subject is the
 * member they tried to add — which is what makes "who kept trying to add whom"
 * answerable at all. `sensitive_access` retention, because that pairing is
 * exactly the kind of record that should not live for seven years and should not
 * be thrown away in ninety days either.
 *
 * FAIL-OPEN, DELIBERATELY AND WITHOUT EXCEPTION. Every failure is caught and
 * logged, and nothing the caller does depends on the result. An audit write that
 * could break a booking would be a worse bug than the leak it observes, and — the
 * point the owner was explicit about — this function must never be able to
 * refuse anybody. It returns `void`. There is no count to branch on and no
 * threshold that changes an outcome; crossing the threshold writes a SECOND audit
 * row — once per actor/target per window — and nothing else.
 *
 * `now` is injected so tests pin the window without touching the wall clock.
 */
export async function recordMemberGuestAddRefusal(params: {
  request: Request;
  actorMemberId: string;
  /** Every beyond-family member named by the refused attempt. */
  targetMemberIds: readonly string[];
  /** Which add path refused, for the admin reading the row. */
  route: string;
  now?: Date;
}): Promise<void> {
  const { request, actorMemberId, targetMemberIds, route } = params;
  const now = params.now ?? new Date();

  if (!actorMemberId || targetMemberIds.length === 0) return;

  const requestContext = getAuditRequestContext(request);

  for (const targetMemberId of targetMemberIds) {
    try {
      await createStructuredAuditLog({
        action: MEMBER_GUEST_REFUSAL_AUDIT_ACTION,
        actor: { memberId: actorMemberId },
        subject: { memberId: targetMemberId },
        category: "privacy",
        severity: "info",
        outcome: "failure",
        summary: "A member-guest add was refused for a member outside the booker's family",
        metadata: { route },
        request: requestContext,
        retentionClass: "sensitive_access",
      });

      const since = new Date(now.getTime() - MEMBER_GUEST_REPEATED_REFUSAL_WINDOW_MS);
      const recentRefusals = await prisma.auditLog.count({
        where: {
          action: MEMBER_GUEST_REFUSAL_AUDIT_ACTION,
          actorMemberId,
          subjectMemberId: targetMemberId,
          createdAt: { gte: since },
        },
      });

      // NOT a cap. Crossing this writes a row an admin can find; it changes
      // nothing about what the caller is told, and the caller never sees it.
      //
      // ONCE PER CROSSING, NOT ONCE PER REFUSAL AFTER THE CROSSING (privacy
      // re-review of MG3 #2308, MEDIUM-1). This used to fire on the fifth
      // refusal AND on every refusal after it, so eight date tweaks in the edit
      // panel — which is one afternoon of ordinary re-dating on a booking that
      // happens to carry a member guest — produced four severity-`important`
      // rows naming an innocent booker. The signal the owner's #2388
      // sub-decision asked for is "somebody crossed the line", and a flood of
      // duplicates is how an admin learns to scroll past it.
      //
      // Asking whether a warning already exists in the window, rather than
      // testing `recentRefusals === THRESHOLD`, is deliberate: concurrent
      // refusals can make the count jump straight from four to six, and an
      // equality test would then never fire at all. The extra read runs only
      // once the threshold is already met, so the common path is unchanged.
      if (recentRefusals >= MEMBER_GUEST_REPEATED_REFUSAL_THRESHOLD) {
        const alreadyWarnedInWindow = await prisma.auditLog.count({
          where: {
            action: MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION,
            actorMemberId,
            subjectMemberId: targetMemberId,
            createdAt: { gte: since },
          },
        });
        if (alreadyWarnedInWindow > 0) continue;

        await createStructuredAuditLog({
          action: MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION,
          actor: { memberId: actorMemberId },
          subject: { memberId: targetMemberId },
          category: "privacy",
          // "important", not "info": this is the row an admin is meant to find.
          // The repo's severity scale is info | important | critical, and
          // "critical" is reserved for things that need acting on now — this
          // needs a look, not an alarm.
          severity: "important",
          outcome: "failure",
          summary:
            `This member has been refused ${recentRefusals} times in 24 hours while ` +
            `trying to add the same other member as a guest. This is usually somebody ` +
            `hunting for a date that suits a friend — nothing has been blocked. Worth ` +
            `a look only if the pattern continues.`,
          metadata: { route, refusalsInWindow: recentRefusals },
          request: requestContext,
          retentionClass: "sensitive_access",
        });
      }
    } catch (err) {
      logger.error(
        { err, actorMemberId, targetMemberId, route },
        "Failed to record a member-guest add refusal; the booking flow is unaffected",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The one call every add path makes on its refusal path
// ---------------------------------------------------------------------------

/**
 * Everything a booking add path owes a COLLAPSED cross-family refusal, in the
 * right order, in one call.
 *
 * The six add paths (the file header lists them) each catch
 * `BookingGuestValidationError` in two or three places; asking every one of them
 * to remember three steps in the right order is how one of them ends up auditing
 * without equalising, or equalising before it has spent the throttle budget.
 * They call this instead.
 *
 * ORDINARY VALIDATION ERRORS PASS STRAIGHT THROUGH. The timing floor applies to
 * collapsed cross-family refusals ONLY — those are the answers that have to be
 * indistinguishable from each other. Putting a quarter-second floor on "check-out
 * must be after check-in" would slow the whole booking flow down to hide nothing.
 * The discriminator is `crossFamilyMemberIds` being present on the error, which
 * only the collapse sites set.
 *
 * EXACTLY ONE UNIT PER ATTEMPT — `throttle` says which side spent it, and the
 * field is REQUIRED so a new add path has to answer the question (correctness
 * review of MG3 #2308, MEDIUM-1).
 *
 * It used to be spent unconditionally here as well as by the routes' own
 * pre-check, so every refusal past that pre-check was charged TWICE and the real
 * budget on the refused path was ~7 per quarter-hour and ~25 per day rather than
 * the 15/50 the limiter, this file and the changelog all advertised. The refused
 * path is both #2388's probe channel AND the owner's explicitly protected honest
 * case — somebody trying five weekends for a friend — so halving it silently was
 * the wrong error to make.
 *
 *   * `"ALREADY_CHARGED"` — the route passed `memberGuestAddThrottleHook` to
 *     `resolveLinkedBookingMembersWithBoundary`, so every cross-family attempt on
 *     it, refused or not, was charged once before a single member row was read.
 *     Nothing more is owed.
 *   * `"CHARGE_NOW"` — the route resolves its members INSIDE a transaction while
 *     holding the per-lodge capacity lock (`bookings/[id]/guests`,
 *     `bookings/[id]/modify`, `bookings/[id]/modify-dates`), where a rate-limit
 *     counter write would take a second connection under that lock. The budget is
 *     spent on the way out instead: the probe is still counted, and the NEXT one
 *     in the run is the one that gets throttled.
 *   * `"CHARGE_IF_UNCHARGED"` — the route has MORE THAN ONE charge point and
 *     which of them fires depends on the request (`bookings/[id]/modify-quote`:
 *     the boundary hook for an attempt that names a beyond-family member, the
 *     whole-party charge for a preview that merely carries one). Neither is
 *     unconditional, so neither `"ALREADY_CHARGED"` nor `"CHARGE_NOW"` is a true
 *     statement about every refusal on it. This spends the unit only if the
 *     request's ledger is still unspent, so the route cannot under-charge — as it
 *     did before HIGH-1, where an empty-`addGuests` preview asserted
 *     `"ALREADY_CHARGED"` having charged nothing at all — and cannot double-charge
 *     either. Requires the `ledger` the route's charge points share.
 *
 * THE 429 IS NEVER RETURNED FROM HERE. On a `"CHARGE_NOW"` route every refusal
 * answers with the same neutral 403 whether or not the budget just ran out, so
 * the two cannot be told apart. Returning the 429 instead would say "you get a
 * 429 only when you guessed a real member", which is the distinction the whole
 * exercise removes. On a `"ALREADY_CHARGED"` route the 429 is raised earlier, by
 * the hook, before anything has been read about the member — so it says nothing
 * either.
 */
export type MemberGuestAddRefusalParams = {
  request: Request;
  actorMemberId: string;
  /** The caught error; only one carrying `crossFamilyMemberIds` does anything. */
  error: { crossFamilyMemberIds?: readonly string[] };
  route: string;
  /** `startMemberGuestRefusalClock()` from the top of the handler. */
  startedAt: MemberGuestRefusalClock;
  skipAuthorization?: boolean;
} & (
  | {
      /** Who charged this attempt's throttle unit — see above. Required on purpose. */
      throttle: "ALREADY_CHARGED" | "CHARGE_NOW";
      ledger?: undefined;
    }
  | {
      throttle: "CHARGE_IF_UNCHARGED";
      /** The ledger this route's charge points share. Required by the type. */
      ledger: MemberGuestAddThrottleLedger;
    }
);

export async function handleMemberGuestAddRefusal(
  params: MemberGuestAddRefusalParams,
): Promise<void> {
  const targetMemberIds = params.error.crossFamilyMemberIds ?? [];
  if (targetMemberIds.length === 0) return;

  if (params.throttle === "CHARGE_NOW" || params.throttle === "CHARGE_IF_UNCHARGED") {
    await applyMemberGuestAddThrottle({
      request: params.request,
      actorMemberId: params.actorMemberId,
      beyondFamilyMemberIds: targetMemberIds,
      skipAuthorization: params.skipAuthorization,
      // Absent on `"CHARGE_NOW"` (one charge point, unconditional); present on
      // `"CHARGE_IF_UNCHARGED"`, where it is what makes this a backstop rather
      // than a second bill.
      ledger: params.ledger,
    });
  }

  await recordMemberGuestAddRefusal({
    request: params.request,
    actorMemberId: params.actorMemberId,
    targetMemberIds,
    route: params.route,
  });

  await equaliseMemberGuestRefusalTiming(params.startedAt);
}
