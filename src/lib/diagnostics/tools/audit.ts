/**
 * AI Diagnostics — the approved-metadata audit row for a tool invocation (AID-5,
 * #2374; contract in ADR-004 §3/§4).
 *
 * WHY `AuditLog` AND NOT A NEW TABLE. ADR-004 §3 says the durable records "follow
 * the platform's existing audit-log retention". `AuditLog` already has the
 * retention classification, the expiry/archive pipeline, the admin query surface
 * and the archive runbook; a parallel `DiagnosticsToolEvent` table would need all
 * four rebuilt and would age out under different rules than the rest of the
 * platform's access trail. AID-2's `DiagnosticsUsageEvent` stays what it is — the
 * PROVIDER metering ledger, one row per paid roundtrip — which is a different
 * event class from "an admin ran a database tool".
 *
 * WHY THIS WRITE USES THE APPLICATION CONNECTION. The SELECT-only role cannot
 * write, by design (ADR-007). ADR-001 §3 already lists metering/audit metadata as
 * the ONE permitted write class, performed on the ordinary first-party path — so
 * the audit row goes through Prisma/`DATABASE_URL`, and the evidence read goes
 * through the restricted role. Two connections, two capabilities, no overlap.
 *
 * WHAT IT RECORDS (exhaustive, ADR-004 §4): tool id, the areas checked, the auth
 * outcome, the failure reason, non-reversible hashes of the accepted arguments
 * and of the result, row/byte counts, duration, round index, observed-at, and —
 * since AID-7a (#2785) — the consent state: which channel invoked it, whether
 * ADR-004 §1's inclusion was granted or refused, the KIND of record consent was
 * about, how that record entered the investigation (or that this investigation did
 * not cover it), and the two per-request ticks, personal details and people search.
 *
 * WHY THE CONSENT FIELDS HAD TO BE ADDED. Without them a
 * `surfacesPersonalData: true` read taken WITH the operator's consent was
 * indistinguishable in the durable log from one taken without it — the same defect
 * shape, one level up, that this whole substrate exists to avoid. ADR-004 §4 permits
 * "auth outcome — allowed / denied, and the area/level checked"; consent is the
 * second half of that authorisation, so recording its outcome is squarely inside the
 * approved set rather than an extension of it.
 *
 * WHAT IT NEVER RECORDS: raw arguments, raw results, the operator's question, the
 * model's answer, provider payloads, credentials, or any unrestricted identifier
 * beyond the acting admin's own member id (which is the accountability field, and
 * is what every other admin audit row in the platform already carries).
 *
 * IN PARTICULAR IT STILL RECORDS NO SUBJECT RECORD ID. The consent fields carry the
 * KIND of record and the ORIGIN of the operator's decision, never the id: `argsHash`
 * already pins which record non-reversibly, and adding the identifier beside it
 * would put an unrestricted personal identifier in a 24-month row.
 */

import "server-only";

import { createStructuredAuditLog, type AuditSeverity } from "@/lib/audit";

import type { DiagnosticsToolAudit } from "./types";

/** The one action string for this event class. Stable — dashboards key on it. */
export const DIAGNOSTICS_TOOL_AUDIT_ACTION = "ai_diagnostics.tool_invocation";

/** The entity type recorded against the registry key. */
export const DIAGNOSTICS_TOOL_AUDIT_ENTITY_TYPE = "diagnostics_tool";

export interface DiagnosticsToolAuditInput {
  /** The acting admin. Accountability field; never a subject member id. */
  actingMemberId: string;
  /** Where the invocation came from, e.g. `ai-diagnostics-chat`. Server-owned. */
  surface: string;
  audit: DiagnosticsToolAudit;
}

/**
 * The metadata object that reaches the row. Built explicitly, field by field, so
 * a future change to `DiagnosticsToolAudit` cannot sweep a new field into a
 * durable row without someone editing this function and thinking about ADR-004.
 * (Spreading the audit object would have been shorter and exactly wrong.)
 */
function auditMetadata(audit: DiagnosticsToolAudit): Record<string, unknown> {
  return {
    toolId: audit.toolId,
    areasChecked: audit.areasChecked,
    authOutcome: audit.authOutcome,
    failureReason: audit.failureReason,
    argsHash: audit.argsHash,
    resultHash: audit.resultHash,
    rowCount: audit.rowCount,
    byteCount: audit.byteCount,
    durationMs: audit.durationMs,
    roundIndex: audit.roundIndex,
    observedAt: audit.observedAt,
    // The six consent fields (AID-7a, #2785). Every one of them is a closed enum or
    // null — there is no free text and no identifier here, which is what keeps this
    // object inside ADR-004 §4's approved set. See the module docblock.
    invocationChannel: audit.invocationChannel,
    sensitiveInclusion: audit.sensitiveInclusion,
    consentRecordKind: audit.consentRecordKind,
    consentRecordOrigin: audit.consentRecordOrigin,
    recordConsentTick: audit.recordConsentTick,
    peopleSearchTick: audit.peopleSearchTick,
  };
}

/**
 * Write the audit row. Deliberately NOT fire-and-forget and deliberately NOT
 * error-swallowing: `invoke.ts` awaits this BEFORE it returns any evidence, and a
 * throw here makes the invocation fail closed with `audit_unavailable`. An
 * unauditable evidence retrieval is precisely what ADR-004 exists to prevent, so
 * "the audit write failed but here are the rows anyway" is not an outcome this
 * substrate offers.
 */
export async function recordDiagnosticsToolAudit(
  input: DiagnosticsToolAuditInput,
): Promise<void> {
  const { audit } = input;
  const failed = audit.failureReason !== null;

  /**
   * An AUTHORIZATION denial — the only thing this row reports as a security block.
   *
   * `internal_error` is excluded, and that exclusion is the rule `invoke.ts` states
   * for itself one level up (#2785 review). Every exit taken BEFORE the permission
   * check records `authOutcome: "denied"`, because nothing had been allowed at that
   * point; for an `internal_error` — a ledger that belongs to another question, a
   * binding that disagrees with its own entry, a collaborator that threw where its
   * contract says it returns — that combination used to produce a security-category,
   * 24-month row at severity `important` with outcome `blocked`, "asserting a
   * permission incident that never happened" (`invoke.ts`, the hoisted fault state).
   * `invoke.ts` fixed it for the faults that happen after authorization by recording
   * `allowed`; the ones that happen before it could not be fixed there without the
   * row claiming an authorization that never ran. So the classification is fixed
   * here, for the whole class: a defect is a `failure`, which is the outcome this
   * function already has for it. The reason, the auth outcome and the consent state
   * are all still recorded in the metadata, and `reportAiError` has already raised
   * the fault where faults are read.
   */
  const deniedAuthorization =
    audit.authOutcome === "denied" && audit.failureReason !== "internal_error";

  // `important` is reserved for an AUTHORIZATION denial, and a consent refusal is
  // deliberately not one (AID-7a, #2785). The caller passed every permission check;
  // what was missing was the operator's own inclusion of a record, which is an
  // ordinary and expected outcome of asking a question about a record you did not
  // select. Raising it to `important` would fill the security-incident view with
  // routine refusals and devalue the rows that are incidents. The refusal is still
  // fully recorded: outcome `failure`, `failureReason`, and `sensitiveInclusion:
  // "refused"` in the metadata.
  const severity: AuditSeverity = deniedAuthorization ? "important" : "info";

  await createStructuredAuditLog({
    action: DIAGNOSTICS_TOOL_AUDIT_ACTION,
    actor: { memberId: input.actingMemberId },
    entity: {
      type: DIAGNOSTICS_TOOL_AUDIT_ENTITY_TYPE,
      // A registry key for every outcome except `unknown_tool`, where it is the id
      // the caller ASKED for — recorded on purpose, because "which name did the
      // model invent" is the forensic content of that row. It is caller text, but
      // it is not free text: `invoke.ts` only records an id that passed
      // `isValidDiagnosticsToolId` (lowercase dotted segments, 64 characters), and
      // anything else is recorded as the literal `unknown`.
      id: audit.toolId,
    },
    category: "security",
    severity,
    outcome: deniedAuthorization ? "blocked" : failed ? "failure" : "success",
    // Fixed sentence plus the tool id above and a fixed enum. Nothing interpolated
    // here can come from the operator or from a database value, and the only
    // model-chosen part is a tool id already constrained to the registry key
    // pattern (see `entity.id`).
    summary: `Diagnostics tool ${audit.toolId} ${
      deniedAuthorization ? "denied" : failed ? "failed" : "ran"
    } on ${input.surface}`,
    metadata: auditMetadata(audit),
    // Diagnostics tool use IS sensitive access: an admin reading club data
    // through a new channel. 24 months, the same class the platform gives its
    // other admin data-access events.
    retentionClass: "sensitive_access",
  });
}
