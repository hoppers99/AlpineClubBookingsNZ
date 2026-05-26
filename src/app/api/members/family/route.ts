import { NextResponse } from "next/server";
import { getMemberFamily } from "@/lib/member-family-service";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";

/**
 * GET /api/members/family
 * Returns self + all active members from all family groups the user belongs to.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const result = await getMemberFamily(session.user.id);
  return NextResponse.json(result.body, result.init);
}
