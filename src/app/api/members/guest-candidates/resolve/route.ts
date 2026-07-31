import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import logger from "@/lib/logger";
import {
  auditMemberGuestResolve,
  loadMemberGuestFindGate,
  resolveMemberGuestCandidatesByEmail,
} from "@/lib/member-guest-find-service";
import {
  equaliseMemberGuestRefusalTiming,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { applyMemberScopedRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * `POST /api/members/guest-candidates/resolve` — MG3's exact-email member
 * finder (epic #2305, #2308). The mode every club gets on day one.
 *
 * **POST, not GET, and the method is load-bearing.** A GET would put another
 * member's email address into the URL, and from there into the access log, the
 * browser history, the `Referer` header of anything the page later loads, and
 * any proxy in between. A POST body goes to none of those.
 *
 * **Module OFF ⇒ 404**, never 403 — see `loadMemberGuestFindGate`.
 *
 * **ALWAYS 200 WITH THE SAME SHAPE** when the module is on. Not found,
 * all-inactive and no-such-member all return `{ candidates: [] }`; the server
 * never sends a reason, and the UI renders one fixed sentence. Nothing about
 * eligibility is evaluated here — see `member-guest-find-service.ts` for why
 * that is the single most important property of the design.
 *
 * **THE RESPONSE FLOOR.** Every answer, including the empty one, is held to the
 * same minimum duration as a collapsed cross-family refusal. Without it the
 * empty answer would be reliably the fast one — one indexed query against the
 * several a populated answer runs downstream — and the uniform envelope would be
 * defeated by a stopwatch. It narrows the channel rather than closing it, and
 * says so where it is defined.
 */
const resolveSchema = z.object({
  email: z.string().trim().min(1).max(320).email(),
});

export async function POST(request: NextRequest) {
  const startedAt = startMemberGuestRefusalClock();

  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const actorMemberId = guard.session.user.id;

  const gate = await loadMemberGuestFindGate({ requiresOpenSearch: false });
  if (!gate.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rateLimited = await applyMemberScopedRateLimit(
    rateLimiters.memberGuestResolve,
    request,
    actorMemberId,
  );
  if (rateLimited) {
    // A member who hits the cap is exactly the signal the audit trail exists
    // for, so the rejection is recorded rather than dropped.
    auditMemberGuestResolve({
      request,
      actorMemberId,
      email: "",
      candidates: [],
      outcome: "blocked",
    });
    return rateLimited;
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = resolveSchema.safeParse(json.body);
  if (!parsed.success) {
    // A malformed address is a client mistake, not a fact about any member, so
    // it may answer honestly — and it must not be an oracle either, which is
    // why it carries no candidate array at all.
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  try {
    const result = await resolveMemberGuestCandidatesByEmail({
      email: parsed.data.email,
    });

    auditMemberGuestResolve({
      request,
      actorMemberId,
      email: parsed.data.email,
      candidates: result.candidates,
    });

    await equaliseMemberGuestRefusalTiming(startedAt);
    return NextResponse.json(result);
  } catch (err) {
    logger.error({ err }, "Failed to resolve member-guest candidates by email");
    // Even the failure keeps the envelope: a 500 on the "member exists" path and
    // a 200 on the "does not" path would be the crudest possible oracle.
    await equaliseMemberGuestRefusalTiming(startedAt);
    return NextResponse.json({ candidates: [] });
  }
}
