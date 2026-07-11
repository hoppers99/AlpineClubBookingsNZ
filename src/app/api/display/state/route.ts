import { NextRequest, NextResponse } from "next/server";
import { checkDisplayAuth } from "@/lib/lodge-display-auth";
import { buildDisplayState } from "@/lib/lodge-display-state";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

// GET /api/display/state?days=N — the lobby display's single data feed
// (fork issue #28, design.md §5). Display-token auth resolves the device's
// bound lodge; the serialiser (lodge-display-state.ts) is the privacy
// enforcement point, so nothing here shapes or filters names. Window size is
// clamped server-side (default 3 days, max 7); an out-of-range request is
// clamped rather than erroring (AC6). Module flag off → proxy-level 404.

export async function GET(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.api, req);
  if (rateLimited) return rateLimited;

  const auth = await checkDisplayAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const daysParam = req.nextUrl.searchParams.get("days");
  const days = daysParam === null ? null : Number(daysParam);

  const state = await buildDisplayState(auth.device.lodgeId, { days });
  if (!state) {
    // The device's lodge no longer exists or is inactive — treat exactly
    // like a failed auth rather than serving a partial payload (AC8).
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  return NextResponse.json(state);
}
