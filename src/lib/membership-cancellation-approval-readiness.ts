/**
 * "Could an approval of this participant be attempted right now?" — one
 * definition, shared by the server that answers it and the page that offers the
 * button (#2402).
 *
 * ## Why it exists
 *
 * The review queue's unpaid-invoice blocker is a LIVE Xero read on a metered
 * daily quota. Running it for a participant nobody can approve — already
 * rejected, already cancelled, still awaiting the member's own confirmation —
 * buys nothing, because there is no approval for the answer to inform. Scoping
 * the check needs a rule for "still awaiting approval", and a rule like that is
 * only safe while EVERY place that depends on it uses the same one.
 *
 * Three places do:
 *
 * 1. `getAdminMembershipCancellationRequests` — which participants the queue
 *    spends a Xero call on;
 * 2. the post-review reload in `reviewMembershipCancellationParticipant` — the
 *    same panel, rebuilt after an action;
 * 3. the queue page's own Approve button — so the button is never enabled on a
 *    row whose checks were skipped, which is the failure mode the whole design
 *    exists to avoid.
 *
 * ## What the rule is, and where it comes from
 *
 * It is the conjunction of the two approval-time guards' own preconditions, read
 * straight off them:
 *
 * - `assertRequestCanBeReviewed` — the REQUEST is still `REQUESTED`;
 * - `assertParticipantCanBeApproved` — the participant is `REQUESTED`, has
 *   confirmed, and the membership is neither deactivated nor already cancelled.
 *
 * Those guards are deliberately NOT re-expressed in terms of this predicate.
 * They throw one specific message each, and rewriting them would have been a
 * change to the approval path, which #2402 is explicitly not. The agreement is
 * held by TEST instead (`membership-cancellation-admin.test.ts`), which drives
 * every shape through both and asserts they answer alike — so if a guard's
 * precondition ever moves without this moving with it, that test fails.
 *
 * That equivalence is the whole justification. It is what makes "we did not
 * check this row" safe: the server would refuse an approval of it anyway, before
 * the check would ever have been consulted.
 *
 * ## Why it lives in its own module
 *
 * The queue page is a client component, and `membership-cancellation-admin.ts`
 * reaches Prisma, email and the audit log. This module imports nothing but
 * Prisma's enum TYPES, which are erased at build, so both sides can hold the
 * identical rule instead of the page carrying a hand-copied approximation of it
 * — which is exactly what it carried before (`status === "REQUESTED" &&
 * confirmedAt`), and exactly how a deactivated member came to render an enabled
 * Approve button beside an empty panel.
 */

import type {
  MembershipCancellationParticipantStatus,
  MembershipCancellationRequestStatus,
} from "@prisma/client";

/**
 * Compile-time pins. Typed as the Prisma enums but compared as literals, so a
 * renamed enum member fails the build here rather than silently making the
 * predicate always-false — while the predicate itself stays usable on the
 * SERIALIZED payload the browser holds, where every status is a plain string.
 */
const REVIEWABLE_REQUEST_STATUS: MembershipCancellationRequestStatus =
  "REQUESTED";
const AWAITING_APPROVAL_PARTICIPANT_STATUS: MembershipCancellationParticipantStatus =
  "REQUESTED";

/**
 * Both shapes the rule is asked about: the Prisma records the server reads, and
 * the JSON the queue page receives (ISO date strings, plain status strings).
 */
export type MembershipCancellationApprovalCandidate = {
  requestStatus: string;
  status: string;
  confirmedAt: Date | string | null;
  member: { active: boolean; cancelledAt: Date | string | null };
};

/** See the module note: this is the approval guards' own preconditions. */
export function isMembershipCancellationParticipantAwaitingApproval(
  candidate: MembershipCancellationApprovalCandidate,
): boolean {
  return (
    candidate.requestStatus === REVIEWABLE_REQUEST_STATUS &&
    candidate.status === AWAITING_APPROVAL_PARTICIPANT_STATUS &&
    Boolean(candidate.confirmedAt) &&
    candidate.member.active &&
    !candidate.member.cancelledAt
  );
}
