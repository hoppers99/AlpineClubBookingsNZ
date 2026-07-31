import type { AgeTier } from "@prisma/client";
import { createStructuredAuditLog, getAuditRequestContext } from "@/lib/audit";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import logger from "@/lib/logger";
import { MEMBER_GUEST_MODULE_KEY } from "@/lib/member-guest-consent";
import {
  EMPTY_MEMBER_GUEST_CANDIDATES,
  MEMBER_GUEST_SEARCH_RESULT_CAP,
  capMemberGuestCandidates,
  memberGuestResolveAgeTiers,
  memberGuestSearchAgeTiers,
  normalizeMemberGuestEmail,
  parseMemberGuestSearchQuery,
  toMemberGuestCandidate,
  truncateSearchQueryForAudit,
  type MemberGuestCandidateResponse,
} from "@/lib/member-guest-find";
import {
  loadMemberGuestSettings,
  type MemberGuestSettingsValues,
} from "@/lib/member-guest-settings";
import { prisma } from "@/lib/prisma";

/**
 * The database half of MG3's member finder (#2308): the two resolution paths and
 * the audit rows they write.
 *
 * THE SINGLE MOST IMPORTANT PROPERTY IN THIS FILE, and the one a reviewer should
 * check first: **neither path evaluates eligibility.** No profile-completeness
 * gate, no subscription check, no person-night check, no "already in your party"
 * filter. That is deliberate and it is what stops the finder becoming an
 * eligibility oracle: it cannot leak whether a member could be booked, because it
 * never asks. Every refusal happens later, at add/quote/create time, collapsed
 * into D-8's one neutral sentence.
 *
 * The only filters either path applies are `active: true` and the age tier — both
 * static properties of the account rather than state that varies by date, so
 * neither can be probed for information. See
 * `MEMBER_GUEST_CANDIDATE_ADULT_TIERS` for why the age-exempt tier is excluded.
 *
 * THE ENVELOPE IS ALWAYS 200 AND ALWAYS THE SAME SHAPE. Not found, all-inactive,
 * no such member and a query below the minimum all return `{ candidates: [] }`.
 * The server never sends a reason string; the UI renders one fixed sentence from
 * the empty array. That is strictly stronger than the partner-link precedent's
 * 404/403/422 split, which this deliberately does not copy.
 */

/** What the module + settings gate decided for one request. */
export type MemberGuestFindGate =
  | { ok: true; settings: MemberGuestSettingsValues }
  /** The module is off, or open search is off on a search request: the route does not exist. */
  | { ok: false };

/**
 * Read the module flag and the policy singleton for a find request.
 *
 * MODULE OFF ⇒ THE ROUTE DOES NOT EXIST (404), never 403. A 403 confirms that
 * the club HAS the feature and merely disabled it for you, which is a fact about
 * the club that an unauthorised caller has no business learning; a 404 is the
 * same answer any unknown path gives. The same reasoning applies to the name
 * search when open search is off.
 */
export async function loadMemberGuestFindGate(params: {
  requiresOpenSearch: boolean;
}): Promise<MemberGuestFindGate> {
  if (!(await isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY))) {
    return { ok: false };
  }
  const settings = await loadMemberGuestSettings();
  if (params.requiresOpenSearch && !settings.openMemberSearchEnabled) {
    return { ok: false };
  }
  return { ok: true, settings };
}

/**
 * Resolve every ACTIVE member at one exact email address (owner decision D-9 as
 * ticked).
 *
 * D-9 was taken against the recommendation: any active member is resolvable,
 * login-holders and non-login members alike, minors included. Households
 * routinely share one address, so this legitimately returns several people and
 * the UI disambiguates. What it discloses is the composition of a household at
 * an address THE BOOKER ALREADY POSSESSED — it reveals nothing about anybody
 * else's address — and that is exactly the trade the owner accepted.
 *
 * The booker's own row and members already in their party are returned rather
 * than filtered out. Filtering server-side would leak "this person is already on
 * your booking" by ABSENCE; the client disables those rows instead, which is
 * harmless because the booker already knows their own party.
 */
export async function resolveMemberGuestCandidatesByEmail(params: {
  email: string;
}): Promise<MemberGuestCandidateResponse> {
  const email = normalizeMemberGuestEmail(params.email);

  const rows = await prisma.member.findMany({
    where: {
      email,
      active: true,
      ageTier: { in: memberGuestResolveAgeTiers() },
    },
    select: { id: true, firstName: true, lastName: true, ageTier: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
  });

  return { candidates: rows.map(toMemberGuestCandidate) };
}

/**
 * The open name type-ahead (MG3-D-b), reachable only when a club has turned it
 * on.
 *
 * PREFIX-ONLY MATCHING, CAPPED AT TEN, NEVER A COUNT. See
 * `parseMemberGuestSearchQuery` for why `contains` is not an option here, and
 * `MemberGuestCandidateResponse.truncated` for why the overflow is a boolean.
 *
 * Ordering is `lastName, firstName, id` so the cap is deterministic: an unstable
 * order would let the same query return different tenths of the roll on repeat,
 * which is a slow way of paging past the cap.
 */
export async function searchMemberGuestCandidatesByName(params: {
  q: string;
  includeMinors: boolean;
}): Promise<MemberGuestCandidateResponse> {
  const parsed = parseMemberGuestSearchQuery(params.q);
  if (!parsed.ok) {
    // Under the two-character floor: no query is issued at all. Still audited by
    // the caller — a run of one-character probes is exactly the shape the audit
    // trail exists to make visible.
    return { candidates: [], truncated: false };
  }

  const ageTiers: AgeTier[] = memberGuestSearchAgeTiers(params.includeMinors);
  const insensitive = { mode: "insensitive" } as const;

  const nameFilter =
    parsed.terms.kind === "SINGLE"
      ? {
          OR: [
            { firstName: { startsWith: parsed.terms.prefix, ...insensitive } },
            { lastName: { startsWith: parsed.terms.prefix, ...insensitive } },
          ],
        }
      : {
          AND: [
            { firstName: { startsWith: parsed.terms.firstPrefix, ...insensitive } },
            { lastName: { startsWith: parsed.terms.lastPrefix, ...insensitive } },
          ],
        };

  const rows = await prisma.member.findMany({
    where: { active: true, ageTier: { in: ageTiers }, ...nameFilter },
    select: { id: true, firstName: true, lastName: true, ageTier: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    // One row over the cap, so "there were more" is knowable without a COUNT.
    take: MEMBER_GUEST_SEARCH_RESULT_CAP + 1,
  });

  return capMemberGuestCandidates(rows.map(toMemberGuestCandidate));
}

// ---------------------------------------------------------------------------
// Auditing — every query, in both modes, including the empty and blocked ones
// ---------------------------------------------------------------------------

export const MEMBER_GUEST_RESOLVE_AUDIT_ACTION = "member_guest.resolve_email";
export const MEMBER_GUEST_SEARCH_AUDIT_ACTION = "member_guest.search";

/**
 * Record an email resolve.
 *
 * THE FULL ADDRESS IS STORED, DELIBERATELY, and this is a disclosure the PR body
 * and the admin guide both state plainly: **an admin reading the audit log will
 * see the email addresses members typed into the finder.** The
 * `getAuditEmailDomain` reduction used elsewhere is not enough here, because the
 * whole purpose of this row is to answer "who looked up which address" — a
 * domain cannot distinguish probing one household from probing forty.
 *
 * `subject.memberId` is set only when exactly ONE candidate came back. On a
 * household hit the row records the lookup without naming any of the people at
 * that address: writing one row per candidate would turn a single lookup into a
 * permanent list of who lives together, which is more than the lookup itself
 * disclosed.
 */
export function auditMemberGuestResolve(params: {
  request: Request;
  actorMemberId: string;
  email: string;
  candidates: readonly { memberId: string }[];
  outcome?: "success" | "blocked" | "failure";
}): void {
  const { request, actorMemberId, email, candidates } = params;
  void createStructuredAuditLog({
    action: MEMBER_GUEST_RESOLVE_AUDIT_ACTION,
    actor: { memberId: actorMemberId },
    subject: {
      memberId: candidates.length === 1 ? candidates[0]!.memberId : null,
    },
    category: "privacy",
    severity: "info",
    outcome: params.outcome ?? "success",
    summary: "A member looked up another member by email address to add as a guest",
    metadata: {
      email: normalizeMemberGuestEmail(email),
      resultCount: candidates.length,
    },
    request: getAuditRequestContext(request),
    retentionClass: "sensitive_access",
  }).catch((err) => {
    logger.error({ err }, "Failed to audit a member-guest email resolve");
  });
}

/**
 * Record a type-ahead query — EVERY query, including under-minimum ones, empty
 * results and rate-limited rejections.
 *
 * `diagnostic_high_volume` retention (ninety days) is the right class and exists
 * for exactly this: with a 300 ms debounce, a two-character floor and the daily
 * cap, the worst case is a few hundred short-lived rows per member per day. The
 * fragment is truncated to 64 characters — enough to see what was being hunted,
 * short enough not to become a text store.
 *
 * No `subject.memberId` is written even on a single hit: a search that returned
 * one person was still a SEARCH, and recording it as a lookup of that person
 * would misrepresent what happened to whoever reads the log later.
 */
export function auditMemberGuestSearch(params: {
  request: Request;
  actorMemberId: string;
  q: string;
  resultCount: number;
  truncated: boolean;
  outcome?: "success" | "blocked" | "failure";
}): void {
  const { request, actorMemberId, q, resultCount, truncated } = params;
  void createStructuredAuditLog({
    action: MEMBER_GUEST_SEARCH_AUDIT_ACTION,
    actor: { memberId: actorMemberId },
    category: "privacy",
    severity: "info",
    outcome: params.outcome ?? "success",
    summary: "A member searched the membership by name to add a guest",
    metadata: {
      q: truncateSearchQueryForAudit(q),
      resultCount,
      truncated,
    },
    request: getAuditRequestContext(request),
    retentionClass: "diagnostic_high_volume",
  }).catch((err) => {
    logger.error({ err }, "Failed to audit a member-guest name search");
  });
}

/** Re-exported so a route can answer with the frozen empty envelope. */
export { EMPTY_MEMBER_GUEST_CANDIDATES };
