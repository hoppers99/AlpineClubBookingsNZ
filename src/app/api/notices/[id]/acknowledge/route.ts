import { NextResponse } from "next/server";
import { getNoticeForMember } from "@/lib/notices";
import { prisma } from "@/lib/prisma";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * Record the acting member's acknowledgement of a notice that requires it.
 * memberId comes FROM THE SESSION ONLY. Audience is re-checked (404 if not
 * visible). Only valid when the notice requiresAcknowledgement. acknowledgedAt
 * is stamped once and never overwritten; readAt is preserved. Idempotent.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }
  const memberId = guard.session.user.id;
  const { id } = await params;

  const notice = await getNoticeForMember(memberId, id);
  if (!notice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!notice.requiresAcknowledgement) {
    return NextResponse.json(
      { error: "This notice does not require acknowledgement" },
      { status: 400 },
    );
  }

  const now = new Date();
  // Ensure a receipt exists (stamping both readAt and acknowledgedAt if brand
  // new), then set acknowledgedAt exactly once via a null-guarded updateMany so
  // a repeat POST never moves the first acknowledgement time.
  // Double-click safety relies on Prisma compiling this compound-unique upsert
  // (no nested writes) to a native INSERT ... ON CONFLICT; a nested-write
  // refactor would fall back to find-then-write and reintroduce a P2002 race.
  await prisma.noticeReadReceipt.upsert({
    where: { noticeId_memberId: { noticeId: id, memberId } },
    create: { noticeId: id, memberId, readAt: now, acknowledgedAt: now },
    update: {},
  });
  await prisma.noticeReadReceipt.updateMany({
    where: { noticeId: id, memberId, acknowledgedAt: null },
    data: { acknowledgedAt: now },
  });

  return NextResponse.json({ ok: true });
}
