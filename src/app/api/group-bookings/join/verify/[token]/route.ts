import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { isActionTokenFormat } from "@/lib/action-tokens";
import { verifyAndCreateNonMemberJoin } from "@/lib/group-booking";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";

/**
 * Public: a non-member confirms their emailed token to finalise a group join.
 * Creates the non-login member, the PENDING child booking, a PENDING payment
 * and a tokenised pay link, then returns the pay token so the caller can send
 * the joiner to /pay/[token].
 *
 * POST (not GET) because it mutates: an email scanner or link-preview bot
 * pre-fetching the link must not create a booking. The service is idempotent,
 * so a genuine double-submit returns the existing booking rather than a second.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.groupBookingToken, request);
  if (rateLimited) return rateLimited;

  const { token } = await params;
  if (!isActionTokenFormat(token)) {
    return NextResponse.json({ outcome: "invalid" }, { status: 404 });
  }

  try {
    const result = await verifyAndCreateNonMemberJoin(token);
    switch (result.outcome) {
      case "invalid":
        return NextResponse.json({ outcome: "invalid" }, { status: 404 });
      case "expired":
        return NextResponse.json({ outcome: "expired" }, { status: 410 });
      case "not_joinable":
        return NextResponse.json(
          { outcome: "not_joinable", message: result.message },
          { status: 409 }
        );
      case "capacity_full":
        return NextResponse.json(
          { outcome: "capacity_full", fullNights: result.fullNights },
          { status: 409 }
        );
      // #2363: the minimum-stay rules changed (or the organiser's dates moved)
      // between staging and this confirmation, so the join fails closed. A 409
      // for the same reason capacity_full is one — the request was fine when it
      // was made and the club's state has since moved under it.
      //
      // `result.message` is the SAME generic sentence the public staging route
      // answers with (`PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE`), and it is the
      // only field forwarded: the frozen snapshot and the detailed sentence
      // naming the rule, its night count and its trigger weekdays stay
      // server-side, so this unauthenticated surface never becomes a
      // policy-configuration read.
      case "minimum_stay":
        return NextResponse.json(
          { outcome: "minimum_stay", message: result.message },
          { status: 409 }
        );
      // #2569: the lodge's hosting rule is set to stop bookings, and a verified
      // non-member join has nobody on it who can cover its nights, so it fails
      // closed. A 409 for the same reason `minimum_stay` is one — the sign-up was
      // fine when it was staged and the club's state (or its policy) has moved
      // under it — and, like that arm, `result.message` is the ONLY field
      // forwarded: this surface is unauthenticated, so the consequence setting,
      // the enabled host scopes and the uncovered nights stay in the server log
      // the service writes beside the refusal rather than one spread from the
      // wire. The member-authenticated paths get the full exception-door body;
      // this one points the joiner at the organiser, who can actually fix it.
      case "adult_member_hosting":
        return NextResponse.json(
          { outcome: "adult_member_hosting", message: result.message },
          { status: 409 }
        );
      case "already_done":
        return NextResponse.json(
          { outcome: "already_done", bookingId: result.bookingId },
          { status: 200 }
        );
      case "created":
        return NextResponse.json(
          {
            outcome: "created",
            bookingId: result.bookingId,
            payToken: result.payToken,
            priceCents: result.priceCents,
            checkIn: result.checkIn.toISOString(),
            checkOut: result.checkOut.toISOString(),
            guestCount: result.guestCount,
          },
          { status: 201 }
        );
    }
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    logger.error({ err }, "Unexpected error verifying group join");
    return NextResponse.json(
      { error: "Unable to confirm your join right now" },
      { status: 500 }
    );
  }
}
