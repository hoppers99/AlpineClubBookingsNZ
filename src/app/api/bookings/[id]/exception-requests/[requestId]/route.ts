import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { cancelModificationExceptionRequest } from "@/lib/booking-exception-request-service";

const patchSchema = z.object({ action: z.literal("cancel") });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Only { action: \"cancel\" } is supported here" },
      { status: 400 },
    );
  }

  const { id: bookingId, requestId } = await params;

  // Guarded single transition REQUESTED -> CANCELLED, scoped to the member's own
  // POLICY_EXCEPTION request. A lost claim runs NO side effect: plain 409, no
  // audit-success, no notification. Scoped to POLICY_EXCEPTION so it can never
  // touch a locked-period change request sharing the table.
  const cancelled = await cancelModificationExceptionRequest({
    id: requestId,
    requestedByMemberId: session.user.id,
  });

  if (!cancelled) {
    return NextResponse.json(
      { error: "This request is no longer open and cannot be cancelled" },
      { status: 409 },
    );
  }

  logAudit({
    action: "booking-policy-exception-request.cancel",
    memberId: session.user.id,
    targetId: bookingId,
    subjectMemberId: session.user.id,
    entityType: "BookingChangeRequest",
    entityId: requestId,
    category: "booking",
    outcome: "success",
    summary: "Modification policy exception request cancelled by member",
    metadata: { source: "MODIFICATION", bookingId, requestId },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json({ id: requestId, status: "CANCELLED" });
}
