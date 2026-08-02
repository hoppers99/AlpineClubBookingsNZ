import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { getDefaultLodgeId } from "@/lib/lodges";
import { parseDateOnly, formatDateOnly } from "@/lib/date-only";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { checkRateLimit, getClientIp, rateLimiters } from "@/lib/rate-limit";
import { sendAdminBookingChangeRequestAlert } from "@/lib/email";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { nameField } from "@/lib/zod-helpers";
import logger from "@/lib/logger";
import { createNewBookingExceptionRequest } from "@/lib/booking-exception-request-service";
import { mapExceptionRequestError } from "@/lib/booking-exception-request-http";

const createSchema = z.object({
  lodgeId: z.string().trim().min(1).optional(),
  checkIn: z.string(),
  checkOut: z.string(),
  guests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().trim().min(1).optional(),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
      }),
    )
    .min(1)
    .max(200),
  memberMessage: z.string().max(5000),
  supersedeRequestId: z.string().trim().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const rl = await checkRateLimit(
    rateLimiters.bookingChangeRequest,
    session.user.id,
  );
  if (!rl.success) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { lodgeId, checkIn, checkOut, guests, memberMessage, supersedeRequestId } =
    parsed.data;

  const parsedCheckIn = parseDateOnly(checkIn);
  const parsedCheckOut = parseDateOnly(checkOut);
  if (
    Number.isNaN(parsedCheckIn.getTime()) ||
    Number.isNaN(parsedCheckOut.getTime())
  ) {
    return NextResponse.json({ error: "Invalid booking date" }, { status: 400 });
  }
  if (parsedCheckOut <= parsedCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 },
    );
  }

  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(prisma));

  try {
    const created = await createNewBookingExceptionRequest({
      requestedByMemberId: session.user.id,
      lodgeId: effectiveLodgeId,
      checkIn: parsedCheckIn,
      checkOut: parsedCheckOut,
      guests,
      memberMessage,
      supersedeRequestId: supersedeRequestId ?? null,
    });

    logAudit({
      action: "booking-policy-exception-request.create",
      memberId: session.user.id,
      targetId: created.id,
      subjectMemberId: session.user.id,
      entityType: "NewBookingPolicyExceptionRequest",
      entityId: created.id,
      category: "booking",
      outcome: "success",
      summary: "New-booking policy exception request submitted",
      details: created.reasonCodes.join(", "),
      metadata: {
        source: "NEW_BOOKING",
        requestId: created.id,
        lodgeId: effectiveLodgeId,
        proposalHash: created.proposalHash,
        reasonCodes: created.reasonCodes,
        aggregateCapacityMode: created.aggregateCapacityMode,
      },
      ipAddress: getClientIp(req),
    });

    // Post-commit, fire-and-forget: an alert failure must never fail the request.
    const summary = `New-booking policy exception (${created.reasonCodes.join(", ")}): ${formatDateOnly(parsedCheckIn)} to ${formatDateOnly(parsedCheckOut)}, ${guests.length} guest(s)`;
    sendAdminBookingChangeRequestAlert({
      memberName: session.user.name ?? session.user.email,
      memberEmail: session.user.email,
      bookingId: `new-booking-request:${created.id}`,
      checkIn: parsedCheckIn,
      checkOut: parsedCheckOut,
      requestedSummary: summary,
      reason: memberMessage,
      requestId: created.id,
    }).catch((err) =>
      logger.error(
        { err, requestId: created.id },
        "Failed to send new-booking policy exception request admin alert",
      ),
    );

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return mapExceptionRequestError(error);
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const requests = await prisma.newBookingPolicyExceptionRequest.findMany({
    where: { requestedByMemberId: session.user.id },
    select: {
      id: true,
      status: true,
      lodgeId: true,
      proposalHash: true,
      aggregateCapacityMode: true,
      memberMessage: true,
      createdAt: true,
      reviewedAt: true,
      supersededByRequestId: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json(requests);
}
