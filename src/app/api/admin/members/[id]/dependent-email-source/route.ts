import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveInheritedEmailSourceId } from "@/lib/member-parent-links";

/**
 * GET /api/admin/members/[id]/dependent-email-source
 *
 * "If a dependent were recorded under this member, whose mailbox would their
 * club email actually land in?" — the same question the member detail payload
 * answers for the member being viewed (`dependentEmailSource`), asked about
 * SOMEBODY ELSE.
 *
 * WHY IT EXISTS (#2282). Recording parentage is now age-blind, but being the
 * club's contact of record is not: `resolveInheritedEmailSourceId` walks UP from
 * the chosen parent to the nearest adult, non-archived, real-address ancestor,
 * and that terminal member — not the parent — is what the write stores. Both
 * link dialogs let an admin choose WHICH parent the notifications route through,
 * and both used to label that choice with the parent's own name while the write
 * quietly stored someone else. The dialogs now ask this route what the write
 * would do, so the name on screen is the mailbox the mail reaches.
 *
 * It is a GET with no side effects, gated on `membership:view` — the same
 * permission that already exposes every member's detail page, which is where
 * both the parent links and the resolved source are already shown. It returns
 * ONE member summary with no field the members list does not already return at
 * that permission.
 *
 * `{ source: null }` is a real answer, not an error: it means nobody in reach
 * can receive club email, which is exactly the 422 the two write paths return.
 * The dialogs use it to disable the save WITH that reason instead of letting the
 * admin discover it on submit.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  if (!id) {
    return NextResponse.json(
      { error: "Invalid route parameters" },
      { status: 400 },
    );
  }

  // Existence is checked rather than inferred from the walk: a resolution of
  // `null` for a member who does not exist would render in the dialog as "no
  // adult in this family can receive club email", which is a different and
  // misleading statement.
  const member = await prisma.member.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const { sourceId } = await resolveInheritedEmailSourceId(prisma, id);
  if (!sourceId) {
    return NextResponse.json({ source: null });
  }

  const source = await prisma.member.findUnique({
    where: { id: sourceId },
    select: { id: true, firstName: true, lastName: true, email: true },
  });

  return NextResponse.json({ source: source ?? null });
}
