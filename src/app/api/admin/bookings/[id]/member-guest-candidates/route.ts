import { NextRequest, NextResponse } from "next/server";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import logger from "@/lib/logger";
import {
  auditMemberGuestResolve,
  auditMemberGuestSearch,
  loadMemberGuestFindGate,
  resolveMemberGuestCandidatesByEmail,
  searchMemberGuestCandidatesByName,
} from "@/lib/member-guest-find-service";
import {
  MEMBER_GUEST_SEARCH_AUDIT_Q_MAX_CHARS,
  normalizeMemberGuestEmail,
} from "@/lib/member-guest-find";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The ADMIN member-pick surface for "+ Add Member Guest" (epic #2305, MG4
 * #2309, owner decisions D-20 and O-4).
 *
 * ONE ROUTE, BOTH MODES, because that is what the shared find panel sends: it
 * classifies what the officer typed and asks for either an exact email or a name
 * fragment. Splitting them would mean two admin routes with one audience and one
 * gate between them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN REUSING THE MEMBER ROUTES
 *
 * The member finder is gated on the club's two privacy settings: name search is
 * off unless a club turns it on, and minors are excluded unless a club opts them
 * in. Owner decision D-20 says the ADMIN picker is bound by neither, and the
 * reasoning is worth stating because the opposite looks safer and is not: an
 * admin holding `membership:view` can already browse the entire membership,
 * minors included, from `/admin/members`. Gating their booking-side picker on a
 * MEMBER-FACING privacy switch protects nobody — it only makes an officer leave
 * the booking, look the member up on another page, come back and paste an
 * address. The setting exists to decide what MEMBERS can see. It is not an
 * access-control mechanism and must not be pressed into service as one, because
 * a club that later turns name search ON would then have no way to say
 * "browsable to officers, not to members" — the two would be one switch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO RIDERS, AND THEY ARE NOT OPTIONAL
 *
 * (a) NAME SEARCH IS GATED ON `membership:view`, NOT ON `bookings:edit`. #1376
 *     exists for one persona: a Booking Officer whose role deliberately does NOT
 *     carry membership access, so they can run bookings without the club's
 *     member directory. Handing that person a name type-ahead over the whole
 *     roll from inside a booking would undo #1376 completely, through a door
 *     nobody thought to look at. So a `membership:view`-less officer gets a 404
 *     on the name mode — the same answer the member route gives when open search
 *     is off — and the shared panel falls back to exact-email resolve, which is
 *     precisely what they have always had through `eligible-family`'s sibling
 *     surfaces. They lose a convenience, not a capability.
 *
 * (b) EVERY RESOLVE IS AUDITED, IDENTICALLY TO THE MEMBER PATH. "Admins can see
 *     everything" is not "admin lookups need no record". The same two audit
 *     writers the member routes use are called here with the same retention
 *     classes, so one query on `member_guest.search` returns members and
 *     officers together rather than officers being invisible in the trail that
 *     exists to make browsing detectable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT COPIED FROM THE MEMBER ROUTES
 *
 * No rate limit and no timing floor. Both exist to make a MEMBER's probing slow
 * and noisy against a surface that is otherwise a stranger-lookup oracle. An
 * officer with `membership:view` is not probing for something they are denied —
 * they hold the directory — so a limiter here would throttle legitimate work to
 * mitigate a risk that does not apply, and the audit trail is the control that
 * does. The email mode is available to any booking officer and is bounded by the
 * same thing that has always bounded it: you must already know the address.
 *
 * MODULE OFF ⇒ 404, never 403, for the same reason as the member routes: a 403
 * confirms the club has the feature and has switched it off, which is a fact
 * about the club an unauthorised caller has no business learning.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Path-derived: `/api/admin/bookings/...` on a GET resolves to bookings:view,
  // which is the floor for looking at anything on a booking at all. The name
  // mode then asks for more, below.
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const actorMemberId = guard.session.user.id;
  await params;

  const mode = request.nextUrl.searchParams.get("mode");
  const gate = await loadMemberGuestFindGate({ requiresOpenSearch: false });
  if (!gate.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (mode === "email") {
    const email = normalizeMemberGuestEmail(
      request.nextUrl.searchParams.get("email") ?? "",
    );
    if (!email) {
      // Same shape a genuine miss gets. A malformed address says nothing about
      // any member, so it must not get its own distinguishable answer.
      return NextResponse.json({ candidates: [] });
    }
    try {
      const result = await resolveMemberGuestCandidatesByEmail({ email });
      await auditMemberGuestResolve({
        request,
        actorMemberId,
        email,
        candidates: result.candidates.map((candidate) => ({
          memberId: candidate.memberId,
        })),
      });
      return NextResponse.json(result);
    } catch (err) {
      logger.error({ err }, "Failed to resolve member-guest candidates for an admin");
      return NextResponse.json({ candidates: [] });
    }
  }

  // Rider (a). The name mode — and only the name mode — needs the directory.
  if (
    !hasAdminAreaAccess(guard.session.user, {
      area: "membership",
      level: "view",
    })
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rawQ = (request.nextUrl.searchParams.get("q") ?? "").slice(
    0,
    MEMBER_GUEST_SEARCH_AUDIT_Q_MAX_CHARS * 4,
  );

  try {
    const result = await searchMemberGuestCandidatesByName({
      q: rawQ,
      // D-20: the officer's search is not bound by the club's member-facing
      // privacy switches, so the minors flag is forced on rather than read.
      // Passing a synthesised settings object keeps the age-tier decision in
      // `searchMemberGuestCandidatesByName` — there is still exactly one place
      // that turns a flag into a set of tiers.
      settings: { ...gate.settings, openMemberSearchIncludesMinors: true },
    });
    await auditMemberGuestSearch({
      request,
      actorMemberId,
      q: rawQ,
      resultCount: result.candidates.length,
      truncated: result.truncated === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.error({ err }, "Failed to search member-guest candidates for an admin");
    return NextResponse.json({ candidates: [], truncated: false });
  }
}
