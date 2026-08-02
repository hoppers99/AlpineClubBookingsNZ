/**
 * AI Diagnostics — resolve an untrusted page selector into typed, permission
 * -scoped, observed-at-stamped page context (AID-4, epic #2369, issue #2373).
 *
 * This is the whole server re-fetch. The order of the gates is the contract:
 *
 *   1. PARSE      structural schema, then the route's own allowlists (parse.ts).
 *   2. AUTHORIZE  the caller's matrix re-read FRESH from the database, AND
 *                 across every area the route declares (authorize.ts, ADR-002).
 *   3. RE-FETCH   a fixed, typed, column-allowlisted projection of the one
 *                 record the selector named (projections.ts).
 *   4. BOUND      redact free text, cap sizes, stamp observed-at, and attach the
 *                 approved audit metadata (ADR-003 §3, ADR-004 §2/§4).
 *
 * A client value never becomes a fact. The selector chooses WHICH registered
 * page and WHICH record id; every value that reaches the model is either
 * server-owned registry metadata or a freshly-read database column. The one
 * exception is deliberate and marked as such: the operator's own view tokens
 * (tab/step/status/error code/filters) are echoed back as "what the operator has
 * on screen", after allowlisting and redaction, and are labelled in the evidence
 * block as the operator's selection rather than as system state.
 *
 * FAIL-CLOSED EVERYWHERE. A malformed selector, an unknown route, an
 * unresolvable actor, a missing area, or a failed read all produce a structured
 * result with NO page facts. Nothing here falls back to a cached matrix, a
 * previous resolution, or a wider projection.
 */

import "server-only";

import { createHash } from "node:crypto";

import type { AdminPermissionArea } from "@/lib/admin-permissions";

import {
  hasAllAreaViews,
  missingAreaViews,
  readFreshAdminPermissionMatrix,
  type FreshAdminPermissionMatrixFailure,
} from "./authorize";
import { boundedRedacted } from "./bound";
import {
  parseDiagnosticsPageSelector,
  type DiagnosticsPageSelector,
} from "./parse";
import { readRecordProjection } from "./projections";
import type { DiagnosticsPageContextRoute } from "./registry";
import {
  DIAGNOSTICS_PAGE_CONTEXT_SCHEMA_VERSION,
  DIAGNOSTICS_SENSITIVE_INCLUSION_COPY,
  type DiagnosticsPageContext,
  type DiagnosticsPageContextAudit,
  type DiagnosticsPageContextFact,
  type DiagnosticsPageContextOmission,
  type DiagnosticsPageContextReason,
  type DiagnosticsPageSelection,
  type DiagnosticsRecordKind,
} from "./types";

export interface ResolveDiagnosticsPageContextInput {
  /** UNTRUSTED client selector. Never pre-validate and pass a trusted object. */
  selector: unknown;
  /** The admin asking. Their permissions are re-read here, not taken on trust. */
  actingMemberId: string;
  /**
   * The resolution instant. Injected so the result is deterministic under test;
   * production callers omit it. Everything in one result shares this instant —
   * the projection is read within it, so a single observed-at is honest.
   */
  observedAt?: Date;
}

/**
 * A NON-REVERSIBLE reference hash for audit correlation. ADR-004 §4 allows a
 * hash where correlation is needed without storing the identifier; the raw id
 * stays in the evidence (the operator supplied it for the page they are on) and
 * never reaches a durable row.
 */
function hashRecordRef(kind: DiagnosticsRecordKind, id: string): string {
  return createHash("sha256").update(`${kind}:${id}`, "utf8").digest("hex");
}

/**
 * The record this resolution ATTEMPTED to read — the server-chosen kind plus the
 * validated id — decided before the read runs and independent of whether it hit.
 *
 * The audit is derived from THIS, never from the result. A miss that audited as
 * "no record requested" would make an id-enumeration sweep invisible, because
 * almost every probe in such a sweep is a miss and only the rare hit would leave
 * a hash. ADR-004 §4 explicitly permits a non-reversible hash of a record
 * reference, so the attempt is recorded without storing any identifier.
 */
interface AttemptedRecordRef {
  kind: DiagnosticsRecordKind;
  id: string;
}

/**
 * The operator's own view tokens, re-emitted after allowlisting. Tabs, steps,
 * statuses and error codes are already registry-allowlisted values, so they pass
 * through as-is; filter VALUES are free text and are redacted and bounded here.
 */
function buildSelection(
  selector: DiagnosticsPageSelector,
): DiagnosticsPageSelection {
  const selection: DiagnosticsPageSelection = {};
  if (selector.tab !== undefined) selection.tab = selector.tab;
  if (selector.step !== undefined) selection.step = selector.step;
  if (selector.status !== undefined) selection.status = selector.status;
  if (selector.errorCode !== undefined) {
    selection.errorCode = selector.errorCode;
  }
  if (selector.filters) {
    const filters: Record<string, string> = {};
    for (const [key, value] of Object.entries(selector.filters)) {
      filters[key] = boundedRedacted(value);
    }
    selection.filters = filters;
  }
  return selection;
}

/**
 * Byte size of the evidence this resolution produced (ADR-004 §4's "byte
 * count"). Measured over the payload, not the rendered block, so the number is
 * stable whatever wrapper a caller later chooses.
 */
function evidenceByteCount(
  selection: DiagnosticsPageSelection,
  facts: DiagnosticsPageContextFact[],
): number {
  return Buffer.byteLength(JSON.stringify({ selection, facts }), "utf8");
}

/**
 * Every way the fresh actor read can fail, mapped to the reason it reports. Held
 * as a total `Record` so a new failure code cannot compile until it has been given
 * a reason — the alternative, a ternary with a fallback, would quietly file a new
 * failure under an existing one.
 */
const ACTOR_FAILURE_REASON: Record<
  FreshAdminPermissionMatrixFailure,
  DiagnosticsPageContextReason
> = {
  member_not_found: "actor_unresolved",
  member_blocked: "actor_blocked",
  read_failed: "actor_read_failed",
};

function audit(input: {
  routeKey: string | null;
  areasChecked: readonly AdminPermissionArea[];
  authOutcome: "allowed" | "denied";
  recordKind: DiagnosticsRecordKind | null;
  recordRefHash: string | null;
  factCount: number;
  byteCount: number;
  observedAt: string;
}): DiagnosticsPageContextAudit {
  return {
    routeKey: input.routeKey,
    areasChecked: [...input.areasChecked],
    authOutcome: input.authOutcome,
    recordKind: input.recordKind,
    recordRefHash: input.recordRefHash,
    factCount: input.factCount,
    byteCount: input.byteCount,
    observedAt: input.observedAt,
  };
}

/**
 * A result with no page facts. Used for every fail-closed exit, so none of them
 * can accidentally carry evidence.
 *
 * `route` is echoed on a DENIAL (the operator already knows which page they are
 * on; telling the model "they are on Payments but lack finance access" is what
 * stops it inventing an answer) and withheld when the selector never named a
 * valid route at all — or when the ACTOR could not be established, where nothing
 * should be echoed to the model before we know who is asking. What the EVIDENCE
 * withholds and what the AUDIT records are separate decisions, which is why they
 * are separate arguments.
 */
function emptyResult(input: {
  status: "denied" | "unavailable";
  reason: DiagnosticsPageContextReason;
  /** Echoed into the evidence. Null renders "page: not identified". */
  route: DiagnosticsPageContextRoute | null;
  omissions: DiagnosticsPageContextOmission[];
  observedAt: string;
  /**
   * The auth outcome to AUDIT. Defaults to `denied`, which is right for every
   * exit that failed a gate — but a read that failed AFTER the permission check
   * passed must audit `allowed`, or the trail reads as a permission incident
   * that never happened.
   */
  authOutcome?: "allowed" | "denied";
  /**
   * The route to AUDIT. Defaults to the evidence route; pass it explicitly on an
   * exit that withholds the route from the model but HAD validated one, so the
   * row can still be correlated to a surface.
   */
  auditRoute?: DiagnosticsPageContextRoute | null;
  /** The record reference that was attempted, if the selector named one. */
  attemptedRecord?: AttemptedRecordRef | null;
}): DiagnosticsPageContext {
  const auditRoute =
    input.auditRoute === undefined ? input.route : input.auditRoute;
  const attempted = input.attemptedRecord ?? null;
  return {
    schemaVersion: DIAGNOSTICS_PAGE_CONTEXT_SCHEMA_VERSION,
    status: input.status,
    reason: input.reason,
    route: input.route
      ? {
          key: input.route.key,
          pathname: input.route.pathname,
          label: input.route.label,
        }
      : null,
    selection: {},
    record: null,
    omissions: input.omissions,
    observedAt: input.observedAt,
    audit: audit({
      routeKey: auditRoute?.key ?? null,
      areasChecked: auditRoute?.requiredAreas ?? [],
      authOutcome: input.authOutcome ?? "denied",
      recordKind: attempted?.kind ?? null,
      recordRefHash: attempted
        ? hashRecordRef(attempted.kind, attempted.id)
        : null,
      factCount: 0,
      byteCount: 0,
      observedAt: input.observedAt,
    }),
  };
}

const AREA_DENIAL_MESSAGE: Record<AdminPermissionArea, string> = {
  overview:
    "You do not have Admin Overview access, so this page's context is omitted.",
  bookings:
    "You do not have Bookings & Beds access, so this page's context is omitted.",
  membership:
    "You do not have Membership access, so this page's context is omitted.",
  finance: "You do not have Finance access, so this page's context is omitted.",
  lodge:
    "You do not have Lodge Operations access, so this page's context is omitted.",
  content: "You do not have Content access, so this page's context is omitted.",
  support:
    "You do not have Support & System access, so this page's context is omitted.",
};

/**
 * Resolve one page context. Never throws for an input or authorization problem —
 * every such case is a structured, evidence-free result, because a thrown error
 * in this path is an outage in the assistant rather than a denial.
 */
export async function resolveDiagnosticsPageContext(
  input: ResolveDiagnosticsPageContextInput,
): Promise<DiagnosticsPageContext> {
  const observedAt = (input.observedAt ?? new Date()).toISOString();

  // 1. Parse. The route comes back with the selector so no later step can
  //    resolve a different route than the one that was validated.
  const parsed = parseDiagnosticsPageSelector(input.selector);
  if (!parsed.ok) {
    return emptyResult({
      status: "unavailable",
      reason: parsed.issues.includes("unknown_route")
        ? "unknown_route"
        : "invalid_selector",
      // Nothing is echoed to the model: a refused selector yields no page context.
      route: null,
      // The route is still AUDITED when the selector named a registered one and
      // only a token failed its allowlist. Without this, a sweep probing a route's
      // allowlists audits as `routeKey: null` — indistinguishable from junk aimed
      // at no page — while the equivalent sweep using a valid token and bad record
      // ids is fully attributable.
      auditRoute: parsed.route ?? null,
      omissions: [],
      observedAt,
    });
  }
  const { selector, route } = parsed;

  // Fixed here, before any read: the SERVER's record kind for this route plus the
  // validated id. Every audit row below derives from this attempt, not from what
  // the read happened to return.
  const attemptedRecord: AttemptedRecordRef | null =
    route.recordKind && selector.recordId
      ? { kind: route.recordKind, id: selector.recordId }
      : null;

  // 2. Authorize, fresh, on every call (ADR-002 §2). No cache, no session copy.
  const actor = await readFreshAdminPermissionMatrix(input.actingMemberId);
  if (!actor.ok) {
    return emptyResult({
      status: "unavailable",
      // A missing member, a locked-out account and an unreadable role graph all
      // deny, but they are different incidents and the trail says which.
      reason: ACTOR_FAILURE_REASON[actor.failure],
      // Nothing is echoed to the model before the actor is established...
      route: null,
      // ...but the route WAS validated, so the audit keeps it: a burst of actor
      // failures is the signature of a database fault or of requests carrying a
      // stale/forged member id, and it can only be triaged against a surface.
      auditRoute: route,
      attemptedRecord,
      omissions: [],
      observedAt,
    });
  }
  const matrix = actor.matrix;

  // `hasAllAreaViews` is the gate (it also refuses an empty area list);
  // `missingAreaViews` only explains the refusal.
  if (!hasAllAreaViews(matrix, route.requiredAreas)) {
    return emptyResult({
      status: "denied",
      reason: "permission_denied",
      route,
      attemptedRecord,
      omissions: missingAreaViews(matrix, route.requiredAreas).map((area) => ({
        code: "permission_denied" as const,
        message: AREA_DENIAL_MESSAGE[area],
        area,
      })),
      observedAt,
    });
  }

  const selection = buildSelection(selector);
  const omissions: DiagnosticsPageContextOmission[] = [];

  // 3. Re-fetch. Only when the SERVER's registry says this page has a record
  //    kind and the operator named an id for it.
  let record: DiagnosticsPageContext["record"] = null;
  let facts: DiagnosticsPageContextFact[] = [];
  if (attemptedRecord) {
    const includeSensitive = selector.includeSensitiveRecord === true;
    let projection;
    try {
      projection = await readRecordProjection(attemptedRecord.kind, {
        id: attemptedRecord.id,
        includeSensitive,
      });
    } catch {
      // A failed read must never look like "this record has nothing to show".
      // The permission check DID pass, so the audit row says so — and the read
      // WAS attempted, so the row carries the attempted reference.
      return emptyResult({
        status: "unavailable",
        reason: "lookup_failed",
        route,
        attemptedRecord,
        omissions: [],
        observedAt,
        authOutcome: "allowed",
      });
    }

    if (projection === null) {
      omissions.push({
        code: "record_not_found",
        message:
          "The record this page named could not be found, so no record detail is included.",
      });
    } else {
      facts = projection;
      record = {
        kind: attemptedRecord.kind,
        id: attemptedRecord.id,
        sensitiveIncluded: includeSensitive,
        facts,
        observedAt,
      };
      if (!includeSensitive) {
        omissions.push({
          code: "sensitive_opt_out",
          message: DIAGNOSTICS_SENSITIVE_INCLUSION_COPY.omittedNotice,
        });
      }
    }
  }

  return {
    schemaVersion: DIAGNOSTICS_PAGE_CONTEXT_SCHEMA_VERSION,
    status: "resolved",
    reason: null,
    route: { key: route.key, pathname: route.pathname, label: route.label },
    selection,
    record,
    omissions,
    observedAt,
    audit: audit({
      routeKey: route.key,
      areasChecked: route.requiredAreas,
      authOutcome: "allowed",
      // The ATTEMPT, not the hit: a miss audits identically to a hit apart from
      // its fact count, so a sweep of non-existent ids is as visible as a real
      // read (see `AttemptedRecordRef`).
      recordKind: attemptedRecord ? attemptedRecord.kind : null,
      recordRefHash: attemptedRecord
        ? hashRecordRef(attemptedRecord.kind, attemptedRecord.id)
        : null,
      factCount: facts.length,
      byteCount: evidenceByteCount(selection, facts),
      observedAt,
    }),
  };
}
