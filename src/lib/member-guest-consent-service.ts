import type { Prisma } from "@prisma/client";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import {
  BookingGuestRemovalError,
  removeBookingGuestInTransaction,
} from "@/lib/booking-guest-removal-service";
import { familyAdultDelegateResolver } from "@/lib/member-guest-delegate";
import type { MemberGuestConsentDelegateResolver } from "@/lib/member-guest-delegate";
import { getDefaultLodgeId } from "@/lib/lodges";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { ApiError } from "@/lib/api-error";
import { MembershipTypeBookingPolicyError } from "@/lib/membership-type-policy";
import { logAudit } from "@/lib/audit";
import {
  sendMemberGuestConsentExpiredEmail,
  sendMemberGuestConsentOutcomeEmail,
} from "@/lib/email/member-guest";
import type { GuestSelfRemovalBlocker } from "@/lib/booking-guest-self-removal";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The member-guest consent state machine ("+ Add Member Guest", epic #2305,
 * MG2 #2307).
 *
 * `PENDING -> CONFIRMED | DECLINED | EXPIRED`, one-way, idempotent, modelled on
 * `MemberPartnerLink`'s `PENDING/CONFIRMED` plus audit-columns shape. `CONFIRMED`
 * is terminal: owner decision **D-13** means no later modification of the booking
 * re-opens it, in either policy mode.
 *
 * THE ONE MECHANISM THAT DELIVERS MOST OF THE CORRECTNESS is the status-guarded
 * `updateMany` in `claimConsentTransition` below. Double-approve,
 * approve-after-expire, decline racing the sweep, and two delegates answering at
 * once all resolve to exactly one winner and exactly one set of side effects,
 * because the loser's `count` is `0` and every side effect — the removal, the
 * bed reconcile, the audit entry, the emails — hangs off a non-zero count. See
 * `docs/CONCURRENCY_AND_LOCKING.md`.
 *
 * DECLINED AND EXPIRED ROWS ARE USUALLY INVISIBLE, and that is intended: the
 * shared removal path DELETES the guest row, so a successful decline leaves no
 * `DECLINED` row behind and the durable record is the audit entry plus the
 * outcome email. The persisted status earns its keep in exactly one case — the
 * claim succeeded but the removal was refused. That row is *blocked*: still
 * holding a bed, needing a human, and surfaced on the admin exception list
 * (owner decision **D-15**).
 */

export type MemberGuestConsentAction = "APPROVE" | "DECLINE";

/**
 * Why a claimed decline or expiry could not be completed.
 *
 * Owner decision **D-15** names exactly four reasons that reach the admin
 * exception list, and they are the four self-removal blockers that survive
 * D-15's credit election: the guest is the booking's last one, the booking was
 * priced by hand, the booking's status forbids guest changes, or check-in has
 * already happened. Everything else — including every ordinary paid booking —
 * resolves without an admin, because the sweep elects account credit.
 */
export type MemberGuestConsentBlockedReason =
  | "LAST_GUEST"
  | "QUOTE_PRICED"
  | "BOOKING_STATUS"
  | "STAY_NOT_FUTURE"
  /** Anything the removal path refused for a reason not in the four above. */
  | "OTHER";

export type MemberGuestConsentOutcome =
  | { outcome: "APPROVED" }
  /**
   * `creditCents` is what the reduction actually settled as account credit, read
   * off the shared removal path's own result rather than recomputed. The outcome
   * email quotes it to the booking owner, so a second calculation here would be a
   * second chance to tell them the wrong number.
   */
  | { outcome: "DECLINED"; removed: true; creditCents: number }
  | { outcome: "EXPIRED"; removed: true; creditCents: number }
  /** Claimed, but the guest is still on the booking and an admin must act. */
  | {
      outcome: "BLOCKED";
      status: "DECLINED" | "EXPIRED";
      reason: MemberGuestConsentBlockedReason;
      message: string;
    }
  /** Somebody (or the sweep) got there first. No side effects, ever. */
  | { outcome: "ALREADY_RESOLVED" };

export class MemberGuestConsentError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * The 403 every unauthorized caller gets, whatever went wrong.
 *
 * One message and one status for "no such booking", "no such guest row", "that
 * row is not a consent request" and "you are not the target or an accepted
 * delegate", so neither id can be used as an existence oracle. Lens (b)'s
 * primary target on this endpoint is IDOR, and this is the answer to it.
 */
function forbidden(): never {
  throw new MemberGuestConsentError("Forbidden", 403);
}

/**
 * Classify a removal refusal into one of D-15's four exception reasons.
 *
 * Matched on the removal service's own messages rather than on a re-derivation of
 * its gates, because the message the member is shown and the reason the operator
 * is shown must be the same fact. A refusal that matches none of the four is
 * `OTHER` and still reaches the exception list — an unclassified block is a
 * visible block, never a swallowed one.
 */
export function classifyConsentRemovalRefusal(
  message: string,
): MemberGuestConsentBlockedReason {
  if (message.includes("Cannot remove the last guest")) return "LAST_GUEST";
  if (message.toLowerCase().includes("quote")) return "QUOTE_PRICED";
  if (message.includes("Only future booking guests")) return "STAY_NOT_FUTURE";
  if (
    message.includes("current status") ||
    message.includes("cannot be modified") ||
    message.includes("can be modified")
  ) {
    return "BOOKING_STATUS";
  }
  return "OTHER";
}

/**
 * The message of a refusal the shared removal path raised, or `null` if this is
 * not a refusal at all.
 *
 * THE REMOVAL PATH REFUSES IN THREE TYPED CLASSES, NOT ONE, and matching only
 * `BookingGuestRemovalError` was a real defect rather than a tidy-up. The gate
 * that blocks a hand-priced booking (`assertBookingNotQuotePriced`) raises
 * `ApiError`, and the membership-type policy check on the REMAINING guests raises
 * `MembershipTypeBookingPolicyError` — both from inside
 * `removeBookingGuestInTransaction`, and both after the status-guarded claim has
 * already succeeded in this same transaction. An unmatched refusal propagates,
 * which rolls the claim back, so the row stays `PENDING`, keeps holding its bed,
 * never reaches D-15's exception list, and is retried by the sweep every night
 * for ever. That is precisely the stranded capacity D-4's deadline exists to
 * prevent, and `classifyConsentRemovalRefusal`'s `QUOTE_PRICED` branch was dead
 * code until this matched the error that carries it.
 *
 * These are the same three classes the guest DELETE route has enumerated for this
 * same function since #1032, which is where the list comes from: it is the shared
 * path's actual contract with its callers — typed domain errors carrying a
 * user-facing sentence and an HTTP status — rather than a guess about what might
 * be thrown. Anything else (a `TypeError`, a lost connection) is NOT a refusal and
 * must keep propagating: marking a row terminal on the strength of a bug would put
 * it on an operator's list with a meaningless reason.
 */
function consentRemovalRefusalMessage(err: unknown): string | null {
  if (
    err instanceof BookingGuestRemovalError ||
    err instanceof ApiError ||
    err instanceof MembershipTypeBookingPolicyError
  ) {
    return err.message;
  }
  return null;
}

type ConsentGuestRow = {
  id: string;
  memberId: string | null;
  consentStatus: string | null;
  consentExpiresAt: Date | null;
  bookingId: string;
};

/**
 * The status-guarded claim. This is the whole idempotency story.
 *
 * Mutation-verify: replace this `updateMany` with a bare `update` by id and a
 * concurrency test must fail — a bare update would let both racers "win" and
 * send two emails for one act.
 */
async function claimConsentTransition(
  tx: Prisma.TransactionClient,
  guestId: string,
  next: "CONFIRMED" | "DECLINED" | "EXPIRED",
  respondedByMemberId: string | null,
  now: Date,
): Promise<boolean> {
  const claimed = await tx.bookingGuest.updateMany({
    where: { id: guestId, consentStatus: "PENDING" },
    data:
      next === "EXPIRED"
        ? // An expiry is nobody's decision, so it records no responder: that is
          // what distinguishes the EXPIRED shape from DECLINED in the model's
          // sub-state table.
          { consentStatus: next }
        : {
            consentStatus: next,
            consentRespondedAt: now,
            consentRespondedByMemberId: respondedByMemberId,
          },
  });
  return claimed.count > 0;
}

/**
 * Remove a just-claimed guest through the shared removal path, or classify the
 * refusal.
 *
 * ONE removal semantics, never a bespoke second delete: capacity release, night
 * deletion, repricing, promo revalidation, chore cleanup, bed reconcile and
 * lifecycle transitions are all inherited from the path a member's own
 * self-removal uses, so a decline and a self-removal cannot diverge.
 */
async function removeClaimedConsentGuest(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    guestId: string;
    targetMemberId: string;
    actorMemberId: string;
    kind: "CONSENT_DECLINE" | "CONSENT_EXPIRY";
    /** D-15's credit election. Only the sweep passes it. */
    settlementMethod?: "credit";
  },
): Promise<
  | { removed: true; creditCents: number }
  | { removed: false; reason: MemberGuestConsentBlockedReason; message: string }
> {
  try {
    const result = await removeBookingGuestInTransaction({
      tx,
      bookingId: params.bookingId,
      guestId: params.guestId,
      actorMemberId: params.actorMemberId,
      actorRole: "MEMBER",
      ...(params.settlementMethod ? { settlementMethod: params.settlementMethod } : {}),
      consentAuthority: {
        kind: params.kind,
        guestId: params.guestId,
        targetMemberId: params.targetMemberId,
      },
    });
    return { removed: true, creditCents: result.accountCreditAmountCents ?? 0 };
  } catch (err) {
    const refusal = consentRemovalRefusalMessage(err);
    if (refusal !== null) {
      return {
        removed: false,
        reason: classifyConsentRemovalRefusal(refusal),
        message: refusal,
      };
    }
    throw err;
  }
}

/**
 * Approve or decline one consent request.
 *
 * Order of operations follows `cron-group-settlement-reaper.ts`: authorize
 * OUTSIDE the transaction, then take the global money/status lock before the
 * per-lodge capacity lock, re-read under the locks, claim, and only then act.
 * External calls (the emails) and the bed reconcile happen AFTER the commit,
 * each independently try/caught, so a mail failure can never roll back a
 * consent decision and no provider call ever sits inside a booking transaction.
 */
export async function respondToMemberGuestConsent(params: {
  bookingId: string;
  guestId: string;
  actorMemberId: string;
  action: MemberGuestConsentAction;
  now?: Date;
  delegateResolver?: MemberGuestConsentDelegateResolver;
  db?: typeof prisma;
}): Promise<MemberGuestConsentOutcome> {
  const {
    bookingId,
    guestId,
    actorMemberId,
    action,
    now = new Date(),
    delegateResolver = familyAdultDelegateResolver,
    db = prisma,
  } = params;

  // Authorization runs on an unlocked read. It is re-asserted implicitly under
  // the lock by the status-guarded claim (a row that changed hands cannot be
  // claimed), and the guest's memberId is immutable, so nothing an attacker can
  // race changes the answer.
  const guest = (await db.bookingGuest.findUnique({
    where: { id: guestId },
    select: {
      id: true,
      memberId: true,
      consentStatus: true,
      consentExpiresAt: true,
      bookingId: true,
    },
  })) as ConsentGuestRow | null;

  if (!guest || guest.bookingId !== bookingId || guest.memberId === null) forbidden();
  if (guest.consentStatus !== "PENDING") {
    // Deliberately the SAME 403 as "not yours". An already-resolved request and
    // a request belonging to somebody else must be indistinguishable, or the
    // endpoint becomes an oracle for who is on which booking.
    forbidden();
  }

  const targetMemberId = guest.memberId;
  const isTarget = targetMemberId === actorMemberId;
  const isDelegate =
    !isTarget &&
    (await delegateResolver.canRespondForTarget({
      actorMemberId,
      targetMemberId,
      db,
    }));

  if (!isTarget && !isDelegate) forbidden();

  const result = await db.$transaction(async (tx) => {
    // Global money/status lock first, then the per-lodge capacity lock: this
    // transaction can reprice a booking AND release a bed, so it belongs in both
    // cohorts and must take them in the repo's declared order.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, lodgeId: true },
    });
    if (!booking) forbidden();
    await acquireLodgeCapacityLock(tx, booking.lodgeId ?? (await getDefaultLodgeId(tx)));

    if (action === "APPROVE") {
      const claimed = await claimConsentTransition(
        tx,
        guestId,
        "CONFIRMED",
        actorMemberId,
        now,
      );
      return claimed
        ? ({ outcome: "APPROVED" } as const)
        : ({ outcome: "ALREADY_RESOLVED" } as const);
    }

    const claimed = await claimConsentTransition(
      tx,
      guestId,
      "DECLINED",
      actorMemberId,
      now,
    );
    if (!claimed) return { outcome: "ALREADY_RESOLVED" } as const;

    // D-14 as ticked: NO exemption from the ordinary self-removal blockers. A
    // member who never consented can still be refused, and the honest answer is
    // to tell them who can act rather than to invent a bypass.
    const removal = await removeClaimedConsentGuest(tx, {
      bookingId,
      guestId,
      targetMemberId,
      actorMemberId,
      kind: "CONSENT_DECLINE",
    });

    if (removal.removed) {
      return {
        outcome: "DECLINED",
        removed: true,
        creditCents: removal.creditCents,
      } as const;
    }
    return {
      outcome: "BLOCKED",
      status: "DECLINED",
      reason: removal.reason,
      message: removal.message,
    } as const;
  });

  return result;
}

/**
 * Expire one lapsed request, for the nightly sweep.
 *
 * Owner decision **D-15**: the sweep elects **account credit to the booking
 * owner** through the shared path's existing `settlementMethod` parameter, so an
 * ordinary paid booking releases its bed on time and no card refund is ever
 * issued that nobody asked for. That election is not a weakening of D-14 — D-14
 * governs what a *guest* may do; this governs a system timer the club configured.
 *
 * MARK BEFORE SEND, on purpose. The destructive database transition IS the
 * idempotency token here, so a failed email is logged for an operator and never
 * replayed into a second removal. (The opposite ordering in
 * `cron-quote-expiry-reminders.ts` is right for a pure reminder and wrong for
 * this.)
 */
export async function expireMemberGuestConsent(params: {
  guestId: string;
  now?: Date;
  db?: typeof prisma;
}): Promise<MemberGuestConsentOutcome> {
  const { guestId, now = new Date(), db = prisma } = params;

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const guest = await tx.bookingGuest.findUnique({
      where: { id: guestId },
      select: {
        id: true,
        memberId: true,
        consentStatus: true,
        consentExpiresAt: true,
        bookingId: true,
        booking: { select: { id: true, lodgeId: true, memberId: true } },
      },
    });

    if (!guest || guest.memberId === null || guest.consentStatus !== "PENDING") {
      return { outcome: "ALREADY_RESOLVED" } as const;
    }

    await acquireLodgeCapacityLock(
      tx,
      guest.booking.lodgeId ?? (await getDefaultLodgeId(tx)),
    );

    // Re-assert the clock on the FRESH row under the lock. The settlement
    // reaper's hard-won lesson: an expiry window can be extended between the
    // candidate scan and the transaction, and expiring a row whose deadline has
    // moved is not idempotent, it is wrong.
    if (!guest.consentExpiresAt || guest.consentExpiresAt > now) {
      return { outcome: "ALREADY_RESOLVED" } as const;
    }

    const claimed = await claimConsentTransition(tx, guestId, "EXPIRED", null, now);
    if (!claimed) return { outcome: "ALREADY_RESOLVED" } as const;

    const removal = await removeClaimedConsentGuest(tx, {
      bookingId: guest.bookingId,
      guestId,
      targetMemberId: guest.memberId,
      // No person acted, so no person is named as the actor. The booking OWNER
      // is passed because they are the party whose booking is repriced and who
      // receives the credit; the true actor is recorded separately in the audit
      // log as `cron:member-guest-consent-expiry`. The target's id is NOT used —
      // writing it here would attribute to them an act they did not take.
      actorMemberId: guest.booking.memberId,
      kind: "CONSENT_EXPIRY",
      settlementMethod: "credit",
    });

    if (removal.removed) {
      return {
        outcome: "EXPIRED",
        removed: true,
        creditCents: removal.creditCents,
      } as const;
    }
    return {
      outcome: "BLOCKED",
      status: "EXPIRED",
      reason: removal.reason,
      message: removal.message,
    } as const;
  });
}

/**
 * Plain-English "what actually fixes this" for an admin looking at a blocked row.
 *
 * D-15 is explicit that the copy must name the REAL remedy — cancel the booking,
 * or re-quote the request — and never a dead-end "ask the club".
 */
export function describeConsentBlockedRemedy(
  reason: MemberGuestConsentBlockedReason,
): string {
  switch (reason) {
    case "LAST_GUEST":
      return "This member is the only guest on the booking, so taking them off would leave it empty. Cancel the booking, or add another guest first.";
    case "QUOTE_PRICED":
      return "This booking was priced by hand, so the system will not reprice it. Re-quote the request without this member.";
    case "BOOKING_STATUS":
      return "This booking's status does not allow guest changes. Move it to a status that does, or cancel it.";
    case "STAY_NOT_FUTURE":
      return "This stay has already started, so the place cannot be released. Check who actually arrived and adjust the booking directly.";
    case "OTHER":
      return "The booking could not be repriced automatically. Open the booking and take this member off through the edit flow.";
  }
}

/**
 * The post-commit half of every transition, shared by the API route and the sweep.
 *
 * Each step is independently try/caught and `logger.error`-only, on the
 * `cron-pre-arrival-reminders.ts` discipline: none of these may undo a consent
 * decision that has already committed, and none of them may prevent the next one
 * from running.
 *
 * `BookingEventType` is a Postgres enum, so a new event value would be a
 * migration and MG2 ships migration-free — consent transitions are therefore
 * audited with `logAudit`, and the removal path still writes whatever
 * `BookingEvent` it already wrote.
 */
export async function finaliseMemberGuestConsentTransition(params: {
  bookingId: string;
  guestId: string;
  targetMemberId: string;
  outcome: MemberGuestConsentOutcome;
  /** The member who acted, or null for the sweep. */
  actorMemberId: string | null;
  /** `cron:member-guest-consent-expiry` for the sweep; undefined for a person. */
  actorLabel?: string;
}): Promise<void> {
  const { bookingId, guestId, targetMemberId, outcome, actorMemberId, actorLabel } =
    params;

  if (outcome.outcome === "ALREADY_RESOLVED") {
    // The claim was lost. No email, no removal, no bed write, no audit entry —
    // the winner already wrote all of them, and a second set would be a lie.
    return;
  }

  if (outcome.outcome === "APPROVED") {
    // The guest is real now and needs a bed. Decline and expiry get their
    // reconcile free — the removal service already calls it — but an approval
    // changes nothing the removal path touches, so this call site is new.
    try {
      await reconcileBedAllocationsForBooking({ bookingId });
    } catch (err) {
      logger.error(
        { err, bookingId, guestId },
        "Failed to reconcile bed allocations after a member-guest consent approval",
      );
    }
  }

  await notifyMemberGuestConsentOutcome({
    bookingId,
    guestId,
    targetMemberId,
    outcome,
  });

  try {
    await logAudit({
      action: `member_guest_consent_${outcome.outcome.toLowerCase()}`,
      category: "booking",
      // A blocked row needs a human, so it is logged as important-and-failed
      // rather than as a routine info line an operator would scroll past.
      severity: outcome.outcome === "BLOCKED" ? "important" : "info",
      outcome: outcome.outcome === "BLOCKED" ? "failure" : "success",
      entityType: "BookingGuest",
      entityId: guestId,
      ...(actorMemberId ? { actorMemberId, memberId: actorMemberId } : {}),
      subjectMemberId: targetMemberId,
      targetId: bookingId,
      summary:
        outcome.outcome === "BLOCKED"
          ? `Member-guest consent ${outcome.status.toLowerCase()} but the guest could not be removed (${outcome.reason}).`
          : `Member-guest consent ${outcome.outcome.toLowerCase()}.`,
      metadata: {
        bookingId,
        guestId,
        targetMemberId,
        ...(actorLabel ? { actor: actorLabel } : {}),
        ...(outcome.outcome === "BLOCKED"
          ? { blockedReason: outcome.reason, blockedMessage: outcome.message }
          : {}),
      },
    });
  } catch (err) {
    logger.error(
      { err, bookingId, guestId },
      "Failed to audit a member-guest consent transition",
    );
  }
}

/**
 * Map a blocked-consent reason back onto the self-removal blocker vocabulary the
 * email copy speaks.
 *
 * The two vocabularies exist for different audiences — one names why an operator
 * has work to do, the other is what a member reads — and this is the single place
 * they are joined, so the copy cannot describe a different situation from the one
 * the exception list is showing.
 */
function selfRemovalBlockerForConsentReason(
  reason: MemberGuestConsentBlockedReason,
): GuestSelfRemovalBlocker {
  switch (reason) {
    case "LAST_GUEST":
      return "LAST_GUEST";
    case "QUOTE_PRICED":
      return "QUOTE_PRICED";
    case "STAY_NOT_FUTURE":
      return "STAY_NOT_FUTURE";
    case "BOOKING_STATUS":
    case "OTHER":
      // An unclassified refusal is described with the booking-status wording,
      // which is the honest general case: something about the booking's state
      // stops it changing, and only the club can look at it.
      return "BOOKING_STATUS";
  }
}

/**
 * Tell the people who need to know, after the transition has committed.
 *
 * Two audiences, and the split is deliberate. The person who MADE the booking
 * always hears the outcome — it is their booking and, on a decline or a lapse,
 * their money that moved. The member who was ASKED hears only that their request
 * lapsed, and only when there was a request to lapse: a notify-only or
 * admin-assigned row was never asked, so telling that member "your request has
 * lapsed" would describe something that never happened.
 *
 * Every send is independently try/caught and `logger.error`-only. The consent
 * decision is already committed; an email provider being down must not undo it,
 * and must not stop the next row in a sweep. Owner decision **D-16** governs
 * whether these are withheld at all: consent-adjacent mail ignores the per-action
 * notify tick and the member's own notification preferences, and is withheld only
 * by the per-booking No-emails switch — that logic lives in the sender and the
 * suppression gate, not here.
 */
async function notifyMemberGuestConsentOutcome(params: {
  bookingId: string;
  guestId: string;
  targetMemberId: string;
  outcome: MemberGuestConsentOutcome;
}): Promise<void> {
  const { bookingId, guestId, targetMemberId, outcome } = params;
  if (outcome.outcome === "ALREADY_RESOLVED") return;

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        lodgeId: true,
        checkIn: true,
        checkOut: true,
        member: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });
    if (!booking) return;

    // The guest row is GONE on a successful decline or expiry — the removal path
    // deleted it — so the target's name comes from the Member record, which is
    // the only surviving source once the row is deleted.
    const target = await prisma.member.findUnique({
      where: { id: targetMemberId },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    const guest = {
      firstName: target?.firstName ?? "A member",
      lastName: target?.lastName ?? "",
    };

    const emailOutcome =
      outcome.outcome === "APPROVED"
        ? ({ kind: "APPROVED" } as const)
        : outcome.outcome === "DECLINED"
          ? ({ kind: "DECLINED", creditCents: outcome.creditCents } as const)
          : outcome.outcome === "EXPIRED"
            ? ({
                kind: "EXPIRED_REMOVED",
                expiredAt: new Date(),
                creditCents: outcome.creditCents,
              } as const)
            : ({
                kind: "EXPIRED_STILL_ON_BOOKING",
                expiredAt: new Date(),
                blocker: selfRemovalBlockerForConsentReason(outcome.reason),
              } as const);

    if (booking.member?.email) {
      try {
        await sendMemberGuestConsentOutcomeEmail({
          bookingId,
          email: booking.member.email,
          firstName: booking.member.firstName ?? "",
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          lodgeId: booking.lodgeId,
          guest,
          outcome: emailOutcome,
        });
      } catch (err) {
        logger.error(
          { err, bookingId, guestId },
          "Failed to send the member-guest consent outcome email to the booking owner",
        );
      }
    }

    // Only a LAPSE gets a notice back to the member who was asked, and it reaches
    // them through the SAME recipient rule the request did — themselves if they
    // hold a login, otherwise the family adults who were asked on their behalf —
    // so nobody is told a request lapsed that they never received.
    //
    // A decline needs no notice: they just made the decision themselves. And an
    // EXPIRED row was necessarily PENDING, which by the model's own shape table
    // means a request really was sent, so this cannot fire for a notify-only or
    // admin-assigned row that nobody was ever asked about.
    const lapsed =
      outcome.outcome === "EXPIRED" ||
      (outcome.outcome === "BLOCKED" && outcome.status === "EXPIRED");

    if (lapsed) {
      const bookerName =
        [booking.member?.firstName, booking.member?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() || "the person who made the booking";

      const recipients = await familyAdultDelegateResolver
        .resolveNotificationRecipients({ targetMemberId, db: prisma })
        .catch((err: unknown) => {
          logger.error(
            { err, bookingId, guestId },
            "Failed to resolve who to tell that a member-guest request lapsed",
          );
          return [];
        });

      if (recipients.length === 0) {
        // Not silent: a target with no login and no family adult cannot be told,
        // and an operator looking at the audit trail needs to know that rather
        // than assume a mail went out.
        logger.warn(
          { bookingId, guestId, targetMemberId },
          "A member-guest request lapsed with nobody to notify",
        );
      }

      for (const recipient of recipients) {
        try {
          await sendMemberGuestConsentExpiredEmail({
            bookingId,
            email: recipient.email,
            firstName: recipient.firstName,
            bookerName,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            lodgeId: booking.lodgeId,
          });
        } catch (err) {
          logger.error(
            { err, bookingId, guestId, recipient: recipient.memberId },
            "Failed to send the member-guest lapse notice",
          );
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, bookingId, guestId },
      "Failed to load booking context for a member-guest consent notification",
    );
  }
}
