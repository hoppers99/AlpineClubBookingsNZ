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
 * and of the result, row/byte counts, duration, round index, observed-at.
 *
 * WHAT IT NEVER RECORDS: raw arguments, raw results, the operator's question, the
 * model's answer, provider payloads, credentials, or any unrestricted identifier
 * beyond the acting admin's own member id (which is the accountability field, and
 * is what every other admin audit row in the platform already carries).
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
  const denied = audit.authOutcome === "denied";
  const failed = audit.failureReason !== null;

  const severity: AuditSeverity = denied ? "important" : "info";

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
    outcome: denied ? "blocked" : failed ? "failure" : "success",
    // Fixed sentence plus the tool id above and a fixed enum. Nothing interpolated
    // here can come from the operator or from a database value, and the only
    // model-chosen part is a tool id already constrained to the registry key
    // pattern (see `entity.id`).
    summary: `Diagnostics tool ${audit.toolId} ${
      denied ? "denied" : failed ? "failed" : "ran"
    } on ${input.surface}`,
    metadata: auditMetadata(audit),
    // Diagnostics tool use IS sensitive access: an admin reading club data
    // through a new channel. 24 months, the same class the platform gives its
    // other admin data-access events.
    retentionClass: "sensitive_access",
  });
}
