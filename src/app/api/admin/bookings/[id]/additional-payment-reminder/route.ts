import { NextRequest, NextResponse } from "next/server";
import { resendAdditionalPaymentEmail } from "@/lib/additional-payment-resend-service";
import { getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

/**
 * POST /api/admin/bookings/[id]/additional-payment-reminder — re-send the email
 * asking the member to pay an extra amount a booking change added (#2350).
 *
 * Authorisation mirrors the sibling admin booking actions (no-emails,
 * capacity-hold, exclusive-hold): `bookings:edit`, and any other caller gets a
 * 403 from `requireAdmin`. The route changes nothing about the booking or the
 * amount owed — it only sends the message again — but it is a member-visible
 * side effect, so it is rate-limited and audited like the rest of them.
 *
 * Refusals are deliberately specific rather than a blanket 400, because each one
 * means something different to the officer looking at the screen: 409 nothing is
 * owed / the booking is silenced or deleted, 429 the member was already emailed
 * inside the cooldown, 502 the mail transport failed and no stamp was kept.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  try {
    const result = await resendAdditionalPaymentEmail({
      bookingId,
      actorMemberId: session.user.id,
      auditRequest: getAuditRequestContext(request),
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      sentAt: result.sentAt,
      additionalAmountCents: result.additionalAmountCents,
    });
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to re-send the additional payment request email",
    );
    return NextResponse.json(
      { error: "Failed to send the payment request email" },
      { status: 500 },
    );
  }
}
