import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getDiagnosticsReadiness,
  getOperationalDiagnosticsApiKey,
  readDiagnosticsModuleFlag,
} from "@/lib/ai-diagnostics-config";
import { isDiagnosticsMeteringHealthy } from "@/lib/ai-diagnostics-usage";
import { reportAiError } from "@/lib/observability-bridge";
import {
  applyRateLimit,
  checkRateLimit,
  rateLimitedResponse,
  rateLimiters,
} from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";

import {
  CONSENT_KIND_FOR_PAGE_RECORD,
  DIAGNOSTICS_ASK_BLOCKED_COPY,
  type DiagnosticsAskBlockedReason,
  type DiagnosticsAskProvenance,
  type DiagnosticsAskResponse,
} from "@/lib/diagnostics/answer/contract";
import { runDiagnosticsAnswer } from "@/lib/diagnostics/answer/loop";
import { buildDiagnosticsProvenance } from "@/lib/diagnostics/answer/provenance";
import { loadKnowledgeBundle } from "@/lib/diagnostics/knowledge/load";
import { renderSourceEvidenceBlock, retrieveExcerpts } from "@/lib/diagnostics/knowledge/retrieve";
import { readFreshAdminPermissionMatrix } from "@/lib/diagnostics/page-context/authorize";
import { matchDiagnosticsPageRoute } from "@/lib/diagnostics/page-context/match";
import { buildPageContextUserTurn } from "@/lib/diagnostics/page-context/render";
import { resolveDiagnosticsPageContext } from "@/lib/diagnostics/page-context/resolve";
import { createDiagnosticsConsentLedger } from "@/lib/diagnostics/tools/consent";
import type { DiagnosticsConsentRecordRef } from "@/lib/diagnostics/tools/consent";
import { createDiagnosticsToolSession } from "@/lib/diagnostics/tools/session";
import { DIAGNOSTICS_ANSWER_BOUNDS } from "@/lib/diagnostics/answer/prompt";

/**
 * POST /api/admin/ai-diagnostics/ask — the AI Diagnostics question route (AID-7,
 * #2378). This is the endpoint that makes the whole AID substrate reachable by a
 * human, which is why every prerequisite issue in the epic exists.
 *
 * THE GATE ORDER, and what each one is for. Nothing below may be reordered without
 * re-deciding the reason it sits where it does:
 *
 *   1. ADMISSION      any admitted administrator (owner decision Q6), encoded as
 *                     `overview:view` — the level every admin access-role grid
 *                     carries, and the same default `guardAdminLayout` applies to an
 *                     admin path with no more specific rule. The shell must NOT
 *                     become a `support:view` permission, and every tool re-derives
 *                     its own areas at invocation. Opening this route grants zero
 *                     evidence access.
 *   2. RATE LIMITS    per-IP then per-admin, BEFORE the body is parsed, so an
 *                     unparseable or oversized body is still throttled. Diagnostics
 *                     has its OWN limiters, not page help's: one question is several
 *                     paid roundtrips.
 *   3. MODULE         fail-closed, BEFORE the body is parsed, and it answers with
 *                     the module gate's own 404 — see the note on
 *                     `moduleOffResponse`. A validation 400 here would prove the
 *                     route exists to exactly the caller the 404 is for.
 *   4. BODY           strict zod. Unknown keys are rejected rather than ignored.
 *   5. GLOBAL LIMIT   the deployment-wide backstop.
 *   6. METERING       can't-record ⇒ don't-spend (ADR-005 §5).
 *   7. OFFER MATRIX   the caller's areas, re-read fresh — early, because the
 *                     refusal tiering in gates 8–9 needs it.
 *   8. READINESS      the same fail-closed verdict the page shows; the credential
 *                     detail in the reason is support-only.
 *   9. CREDENTIAL     the DEDICATED diagnostics key, never the page-help one.
 *  10. CONTEXT        the client's selector is RE-RESOLVED server-side, under this
 *                     admin's own freshly-read authority, before anything reads a
 *                     record. Client values are selectors, never facts.
 *  11. CONSENT        this question's ledger, seeded ONLY from what step 10 actually
 *                     resolved and from the operator's two per-request ticks.
 *  12. ANSWER         the bounded loop.
 *
 * NOTHING HERE PERSISTS A CONVERSATION (owner decision Q5). The transcript arrives in
 * the request, is replayed as untrusted data, and is gone when the response is written.
 * A page reload loses the conversation, which the issue explicitly accepts: "do not
 * silently introduce persistence to avoid that UX cost."
 */

/** Wire caps mirror the prompt module's own bounds, so we never over-send. */
const bodySchema = z
  .object({
    pathname: z.string().min(1).max(300).regex(/^\//, "pathname must start with /"),
    question: z.string().min(1).max(DIAGNOSTICS_ANSWER_BOUNDS.questionMaxChars),
    transcript: z
      .array(
        z
          .object({
            role: z.enum(["operator", "assistant"]),
            text: z.string().min(1).max(DIAGNOSTICS_ANSWER_BOUNDS.turnMaxChars),
          })
          .strict(),
      )
      .max(DIAGNOSTICS_ANSWER_BOUNDS.maxReplayedTurns),
    /**
     * BOTH TICKS ARE REQUIRED FIELDS WITH NO DEFAULT (owner decision D9).
     *
     * A `.default(false)` would be fail-closed and would still be wrong: it would let
     * a client omit the field entirely and leave no way to tell "the operator left it
     * unticked" from "this client does not know the control exists". They are the two
     * controls this product's privacy argument rests on, and the request is required
     * to state both.
     */
    allowPeopleSearch: z.boolean(),
    allowRecordPersonalDetails: z.boolean(),
    /**
     * The record the operator has open, when the page they are on is a LIST rather
     * than a detail URL.
     *
     * IT IS A SELECTOR, AND ONLY A SELECTOR. The server picks the KIND from the route
     * it matched — `page-context/registry.ts`: "The client picks the ID; the SERVER
     * picks the KIND — which is why a member id sent on a booking route can only ever
     * fail to find a booking, never read a member" — then re-resolves the record under
     * this admin's own freshly-read authority and returns a bounded projection. Nothing
     * here is trusted; it selects what the server then re-establishes.
     *
     * IT HAS TO EXIST, and the first cut of this route left it out on the grounds that
     * a request carrying no client identifier is safer. It is, and it also cannot
     * answer the product's flagship question: this codebase has NO `/admin/bookings/[id]`
     * page — bookings open from the list — so a URL-only rule means no booking can ever
     * be the subject of an investigation. AID-4 anticipated exactly this, which is why
     * its own selector schema makes `recordId` optional and why the LIST routes declare
     * a `recordKind` despite having no dynamic segment.
     *
     * A record id in the URL wins over this one: an operator on a detail page is
     * unambiguously asking about that record.
     */
    recordId: z.string().min(1).max(64).optional(),
    /**
     * The operator's own allowlisted VIEW state for the page they are on — which tab
     * they have open, which status they filtered to.
     *
     * It carries no route key: the server derives that from `pathname` (see gate 10).
     * These fields are re-validated against the matched route's OWN declared
     * tabs/steps/statuses by `parseDiagnosticsPageSelector`, so an unknown token is
     * refused there rather than trusted here. Bounds are left to that parser too —
     * restating them would be a second set to drift.
     */
    view: z
      .object({
        tab: z.string().optional(),
        step: z.string().optional(),
        status: z.string().optional(),
        errorCode: z.string().optional(),
        filters: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The module-off reply: byte-identical to what the feature-route gate itself sends.
 *
 * `/api/admin/ai-diagnostics` is module-gated in `config/feature-routes.ts`, with only
 * the readiness route exempted, so in production the proxy answers this address with a
 * frozen 404 long before the handler runs. The in-handler check below is defence in
 * depth — a route must not depend on a proxy having gated it — and it answers with the
 * SAME 404 rather than a friendlier structured body, because a different reply here
 * would re-create exactly the difference the frozen 404 exists to remove: one request
 * that distinguishes "the module is off" from "this address does not exist".
 *
 * The UI learns the module state from the READINESS route instead, which is exempt
 * from the gate precisely so a disabled module can still explain itself.
 */
function moduleOffResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function blocked(
  reason: DiagnosticsAskBlockedReason,
  provenance?: DiagnosticsAskProvenance,
): NextResponse {
  const copy = DIAGNOSTICS_ASK_BLOCKED_COPY[reason];
  const body: DiagnosticsAskResponse = {
    status: "blocked",
    reason,
    message: copy.message,
    ...(copy.nextStep ? { nextStep: copy.nextStep } : {}),
    ...(provenance ? { provenance } : {}),
  };
  // A 200 with a structured reason, not an HTTP error. Every one of these is a
  // CONDITION the operator can understand and often act on — a spent budget, a busy
  // provider, a deployment that is not set up — and #2378 requires them to be
  // first-class UX rather than "AI failed". The transport succeeded; the answer is the
  // refusal.
  return NextResponse.json(body);
}

export async function POST(request: Request) {
  // 1. ADMISSION — any admitted administrator (owner decision Q6).
  //
  //    `overview:view` IS "any admitted admin", not a permission carve-out: every
  //    admin access-role grid carries it, and it is the same default requirement
  //    `guardAdminLayout` applies to an admin path with no more specific rule —
  //    including `/admin/ai-diagnostics` itself, which deliberately falls to the
  //    overview catch-all (see `admin-permissions.ts`, OVERVIEW_ALLOWLIST).
  //
  //    The first cut of this route wrote `permission: false`, believing that meant
  //    "any admitted admin". It meant Full Admin only: with no requirement,
  //    `requireAdmin` falls through to `hasAdminAccess`, the literal `ADMIN` role —
  //    so every scoped admin the layout had already shown the Diagnostics tab to
  //    got a 403 their client could only report as a network fault, and the
  //    per-invocation area checks (the actual security boundary) were never
  //    exercised by anyone who did not already hold every area.
  const guard = await requireAdmin({
    permission: { area: "overview", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const actingMemberId = guard.session.user.id;

  // 2. RATE LIMITS, before the body is read.
  const ipLimited = await applyRateLimit(rateLimiters.aiDiagnosticsIp, request);
  if (ipLimited) return ipLimited;
  const adminLimit = await checkRateLimit(
    rateLimiters.aiDiagnosticsAdmin,
    actingMemberId,
  );
  if (!adminLimit.success) return rateLimitedResponse(adminLimit);

  // 3. MODULE — before the body is parsed. Tri-state: `null` means the setting could
  //    not be READ (#2803), which is not the same as off — but it is equally not
  //    authorisation to spend, so both refuse. This gate sits ABOVE body validation
  //    so a malformed body cannot turn the frozen 404 into a 400 that proves the
  //    route exists — `moduleOffResponse`'s whole point is that a module-off
  //    deployment is indistinguishable from an address that was never registered.
  const moduleEnabled = await readDiagnosticsModuleFlag();
  if (moduleEnabled !== true) return moduleOffResponse();

  // 4. BODY.
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const {
    pathname,
    question,
    transcript,
    allowPeopleSearch,
    allowRecordPersonalDetails,
    recordId,
    view,
  } = parsed.data;

  // 5. GLOBAL BACKSTOP.
  const globalLimit = await checkRateLimit(rateLimiters.aiDiagnosticsGlobal, "global");
  if (!globalLimit.success) return blocked("rate_limited");

  // 6. METERING.
  if (!isDiagnosticsMeteringHealthy()) return blocked("metering_unavailable");

  // 7. THE OFFER MATRIX, re-read FRESH from the database — before the readiness
  //    gates, because the refusal tiering below needs it.
  //
  //    Not `guard.session.user.adminPermissionMatrix`, even though the guard just
  //    built one. `readFreshAdminPermissionMatrix` is the substrate's own reader and
  //    its docblock names this route as the place the two-factor half of the check
  //    belongs — which `requireAdmin` above has already done, so the pair is complete
  //    here and nowhere else. It also refuses a member who has been deactivated or
  //    put under a forced password change, as a typed failure rather than an empty
  //    matrix that would quietly look like "no areas".
  //
  //    This matrix ONLY decides which tools are OFFERED and how a refusal is worded.
  //    `invoke.ts` re-reads the caller's authority on every single invocation, so
  //    nothing here is the security boundary — see `definitions.ts`, which is
  //    emphatic that withholding is courtesy and never the control.
  const freshMatrix = await readFreshAdminPermissionMatrix(actingMemberId);
  if (!freshMatrix.ok) {
    // A read failure is not a permission answer, so it must not be treated as one.
    // Fail closed and say the product is unavailable rather than answering with an
    // empty toolset, which would look to the operator like "diagnostics found nothing".
    return blocked("provider_unavailable");
  }
  const matrix = freshMatrix.matrix;
  // The stored-credential state is one of exactly three things the readiness
  // contract keeps behind `support:view` (`diagnostics-readiness-tiers.ts`), and
  // now that ANY admitted admin can reach this route, saying "no API key yet" to a
  // caller without that area would leak it. They get the same coarse "not ready"
  // sentence the tiered page shows them, which already says who can resolve it.
  const canSeeOperationalDetail = matrix.support !== "none";

  // 8. READINESS — the same fail-closed verdict the page shows, so the two never
  //    disagree about whether this product can answer.
  const readiness = await getDiagnosticsReadiness({ aiDiagnostics: moduleEnabled });
  if (!readiness.ready) {
    // The blocker LIST is support-only (owner decision Q6, tiered readiness), so the
    // reason here is deliberately coarse: "not ready" plus where to look. The page is
    // where a support admin sees which gate failed.
    return blocked(
      readiness.keyState === "not_configured" && canSeeOperationalDetail
        ? "not_configured"
        : "not_ready",
    );
  }

  // 9. CREDENTIAL — the dedicated diagnostics key. Same tiering as gate 8: the
  //    credential state is support-only detail.
  const apiKey = await getOperationalDiagnosticsApiKey();
  if (!apiKey) {
    return blocked(canSeeOperationalDetail ? "not_configured" : "not_ready");
  }

  // 10. PAGE CONTEXT.
  //
  //    THE SERVER PICKS THE ROUTE, THE CLIENT ONLY SAYS WHERE IT IS. The browser sends
  //    its pathname; `matchDiagnosticsPageRoute` turns that into the registry's own
  //    `routeKey` plus the id that filled the dynamic segment. The client never names a
  //    route key, because naming the key would be naming the record KIND — see that
  //    module's docblock, and `registry.ts`'s own statement of the property.
  //
  //    `includeSensitiveRecord` is set from the operator's tick HERE, server-side, and
  //    any value a client sent for it is not consulted: there is exactly one source of
  //    truth for that decision on this request, and it is the same boolean that seeds
  //    the consent ledger below. Two channels, ONE operator decision — a request that
  //    could set them apart would be a request that reads personal fields on one
  //    channel while the ledger says they were withheld.
  //
  //    An unmatched pathname is not an error: it is a page with no registered context.
  //    The resolver is still called, with no route, so the evidence block says what
  //    could not be established rather than silently omitting the section.
  const matched = matchDiagnosticsPageRoute(pathname);
  // The URL's own record wins over the one the page registered: an operator on a
  // detail page is unambiguously asking about that record, and a stale registration
  // from a list they were on before must not override it. `recordId` is offered only
  // where the matched route declares a kind for it — sending one for a static page
  // would be selecting a record the route can never be about.
  //
  // An ILL-FORMED id is dropped rather than passed through, because the selector
  // parser downstream rejects its WHOLE selector on a malformed id — so an operator
  // sitting on a bogus `/admin/members/foo.bar` would lose the entire page context
  // instead of degrading to "route matched, no record". Dropping it here keeps the
  // context and lets the evidence block say the record could not be established.
  // The pattern matches the selector parser's own (`page-context/parse.ts`).
  const wellFormed = (id: string | undefined) =>
    id && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
  const selectedRecordId =
    wellFormed(matched?.recordId) ??
    (matched?.route.recordKind ? wellFormed(recordId) : undefined);
  const pageContext = await resolveDiagnosticsPageContext({
    selector: matched
      ? {
          routeKey: matched.route.key,
          ...(selectedRecordId ? { recordId: selectedRecordId } : {}),
          ...(view ?? {}),
          includeSensitiveRecord: allowRecordPersonalDetails,
        }
      : { routeKey: null },
    actingMemberId,
  });
  const pageContextBlock = buildPageContextUserTurn(pageContext).content;

  // 11. CONSENT. Seeded ONLY from the record the server itself just resolved — never
  //     from an id the client named. A `denied` or `unavailable` resolution seeds
  //     NOTHING, which is the fail-closed direction: the operator's ticks then apply to
  //     an empty investigation and every per-record entry refuses, which is exactly
  //     what should happen when the server could not establish what they are looking at.
  const selectedRecords: DiagnosticsConsentRecordRef[] =
    pageContext.status === "resolved" && pageContext.record
      ? [
          {
            kind: CONSENT_KIND_FOR_PAGE_RECORD[pageContext.record.kind],
            id: pageContext.record.id,
          },
        ]
      : [];

  const consent = createDiagnosticsConsentLedger({
    recordConsentGranted: allowRecordPersonalDetails,
    peopleSearchGranted: allowPeopleSearch,
    selectedRecords,
  });
  const session = createDiagnosticsToolSession();

  // DEPLOYED-CODE EVIDENCE (AID-3), when this deployment carries a bundle. A missing
  // bundle is the expected "diagnostics not provisioned" case and is NOT a refusal:
  // the answer proceeds on runtime evidence alone, which is the issue's own
  // "runtime evidence available while deployed-code evidence is not" state seen from
  // the other side. `loadKnowledgeBundle` never throws.
  let sourceBlock: string | undefined;
  const bundle = await loadKnowledgeBundle();
  if (bundle.ok) {
    const excerpts = retrieveExcerpts(bundle.bundle, question);
    if (excerpts.length > 0) sourceBlock = renderSourceEvidenceBlock(excerpts);
  }

  // 12. ANSWER.
  const result = await runDiagnosticsAnswer({
    apiKey,
    actingMemberId,
    matrix,
    question,
    priorTurns: transcript,
    consent,
    session,
    sourceBlock,
    pageContextBlock,
  });

  const provenance = buildDiagnosticsProvenance({
    sources: result.sources,
    summary: result.summary,
    roundsUsed: result.roundsUsed,
  });

  if (!result.ok) {
    if (result.reason === "provider_unavailable") {
      reportAiError({
        tag: "diagnostics-ask-unavailable",
        message: "An AI Diagnostics question could not be answered by the provider",
        // The matched ROUTE KEY, never the raw pathname: a members-detail pathname
        // carries a member id, and the AID substrate keeps identifiers out of
        // durable rows and telemetry alike. The key names the screen, which is all
        // an operator debugging provider availability needs.
        context: { routeKey: matched?.route.key ?? "unmatched" },
      });
    }
    return blocked(result.reason, provenance);
  }

  const body: DiagnosticsAskResponse = {
    status: "answered",
    answer: result.answer,
    truncated: result.truncated,
    provenance,
  };
  return NextResponse.json(body);
}
