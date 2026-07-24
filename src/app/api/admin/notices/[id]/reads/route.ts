import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveNoticeAudienceMembers } from "@/lib/notices";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({ id: z.string().min(1) });

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Read-status report for one notice (view level). The notice's CURRENT effective
 * audience left-joined with its read receipts, paginated, plus summary counts.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid route parameters" }, { status: 400 });
  }
  const noticeId = parsedParams.data.id;

  const notice = await prisma.notice.findUnique({
    where: { id: noticeId },
    select: { id: true, requiresAcknowledgement: true },
  });
  if (!notice) {
    return NextResponse.json({ error: "Notice not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number.parseInt(url.searchParams.get("pageSize") ?? `${DEFAULT_PAGE_SIZE}`, 10) ||
        DEFAULT_PAGE_SIZE,
    ),
  );

  const audience = await resolveNoticeAudienceMembers(noticeId);
  const receipts = await prisma.noticeReadReceipt.findMany({
    where: {
      noticeId,
      memberId: { in: audience.map((a) => a.memberId) },
    },
    select: { memberId: true, readAt: true, acknowledgedAt: true },
  });
  const receiptByMember = new Map(receipts.map((r) => [r.memberId, r]));

  const rows = audience.map((member) => {
    const receipt = receiptByMember.get(member.memberId) ?? null;
    return {
      memberId: member.memberId,
      name: member.name,
      email: member.email,
      audienceVia: member.audienceVia,
      readAt: receipt?.readAt.toISOString() ?? null,
      acknowledgedAt: receipt?.acknowledgedAt?.toISOString() ?? null,
    };
  });

  const audienceCount = rows.length;
  const readCount = rows.filter((r) => r.readAt !== null).length;
  const acknowledgedCount = rows.filter((r) => r.acknowledgedAt !== null).length;

  const start = (page - 1) * pageSize;
  const pagedRows = rows.slice(start, start + pageSize);

  return NextResponse.json({
    requiresAcknowledgement: notice.requiresAcknowledgement,
    rows: pagedRows,
    page,
    pageSize,
    total: audienceCount,
    totalPages: Math.max(1, Math.ceil(audienceCount / pageSize)),
    audienceCount,
    readCount,
    acknowledgedCount,
  });
}
