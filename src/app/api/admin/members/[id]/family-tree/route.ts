import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getMemberFamilyTree } from "@/lib/member-family-tree";

/**
 * GET /api/admin/members/[id]/family-tree
 *
 * Read-only derived family tree for the admin member page's Family card
 * (#2253). Admin-only by owner decision; gated on membership:view — the same
 * permission that already exposes every member's detail page, which is where
 * all of the data this tree derives from (parent links, dependants, partner
 * links, family groups) is already visible. The tree adds no write surface
 * and no fields beyond that page; archived members appear with contact
 * details suppressed.
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
    return NextResponse.json({ error: "Invalid route parameters" }, { status: 400 });
  }

  const tree = await getMemberFamilyTree(prisma, id);
  if (!tree) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  return NextResponse.json(tree);
}
