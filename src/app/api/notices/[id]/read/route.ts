import { NextResponse } from "next/server";
import { getNoticeForMember } from "@/lib/notices";
import { prisma } from "@/lib/prisma";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * Record that the acting member has opened a notice. memberId comes FROM THE
 * SESSION ONLY (never the body). Audience is re-checked via getNoticeForMember,
 * so an out-of-audience or non-existent notice returns 404 (indistinguishable).
 * The receipt upsert never overwrites an existing readAt, so a repeat POST keeps
 * the first-open timestamp.
 *
 * Fired by the client <MarkNoticeRead> component on detail-page mount — never a
 * server-render side effect, so a Link prefetch can never forge a read.
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

  await prisma.noticeReadReceipt.upsert({
    where: { noticeId_memberId: { noticeId: id, memberId } },
    create: { noticeId: id, memberId },
    // Never overwrite readAt — the first open is authoritative.
    update: {},
  });

  return NextResponse.json({ ok: true });
}
