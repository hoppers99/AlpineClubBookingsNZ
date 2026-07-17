import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { hasAdminAccess } from "@/lib/access-roles";
import { issueSplitGuestPaymentLink } from "@/lib/payment-link";
import logger from "@/lib/logger";

/**
 * Split-booking guest-portion payment link, on demand (#1967).
 *
 * The booker calls this from the booking-detail page when they switch their own
 * place to Internet Banking and their non-member guests are held in a linked
 * provisional child: with no card on file, the guest portion cannot be
 * auto-charged at settlement, so this emails the member a secure `/pay/<token>`
 * link for each provisional child. It reuses the same idempotent
 * `issueSplitGuestPaymentLink` helper the settlement cron uses, so a second
 * click (or a click racing the cron) never mints or emails a duplicate link.
 *
 * `id` is the PARENT (member) booking id; links are issued for its linked
 * PENDING non-member children.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: {
      memberId: true,
      deletedAt: true,
      linkedBookings: {
        where: { status: BookingStatus.PENDING, hasNonMembers: true },
        select: { id: true },
      },
    },
  });

  if (!booking || booking.deletedAt) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (booking.memberId !== session.user.id && !hasAdminAccess(session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const children = booking.linkedBookings;
  if (children.length === 0) {
    return NextResponse.json(
      { error: "This booking has no provisional guests to send a payment link for." },
      { status: 400 }
    );
  }

  let sent = 0;
  let alreadyActive = 0;
  let suppressed = 0;
  for (const child of children) {
    try {
      const result = await issueSplitGuestPaymentLink(child.id);
      if (result.outcome === "sent") sent += 1;
      else if (result.outcome === "already_active") alreadyActive += 1;
      else if (result.outcome === "suppressed") suppressed += 1;
    } catch (err) {
      logger.error(
        { err, bookingId: child.id, parentBookingId: id },
        "Failed to issue split guest payment link"
      );
      return NextResponse.json(
        { error: "Unable to send the payment link right now. Please try again." },
        { status: 500 }
      );
    }
  }

  if (suppressed > 0 && sent === 0) {
    // Every recipient address is SES-suppressed (prior bounce/complaint): the
    // link was minted but nothing was delivered, so tell the truth (F25/#1885).
    return NextResponse.json(
      {
        error:
          "We couldn't email your payment link (your email address is undeliverable). Please contact the club.",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ sent, alreadyActive, suppressed });
}
