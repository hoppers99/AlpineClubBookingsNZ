/**
 * AI Diagnostics — the tool definitions handed to the model (AID-5, #2374;
 * contract in ADR-002 §2).
 *
 * WITHHOLDING IS COURTESY, NOT SECURITY. A caller who lacks `view` on a tool's
 * area is not offered that tool, purely so the model does not propose something
 * the operator will be refused, and so a finance-only admin's question is not
 * answered with a list of booking tools they cannot run. That is a usability
 * property.
 *
 * The SECURITY property lives entirely in `invoke.ts` → `authorize.ts`: every
 * invocation re-reads the caller's matrix from the database and denies unless
 * they hold `view` on every area the entry declares. An invocation naming a
 * withheld tool id — because the model hallucinated it, because an operator
 * replayed a request, or because a role was revoked between the definition list
 * and the call — is authorized and denied on its own merits. Nothing in this file
 * is load-bearing for that, and nothing in this file may ever become the only
 * thing standing between a caller and a tool.
 *
 * The shape returned is the Anthropic tool-definition shape (`name`,
 * `description`, `input_schema`), built from server-owned registry text. No
 * operator input, model output or database value is interpolated into it.
 */

import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

import { hasAllAreaViews } from "../page-context/authorize";
import { DIAGNOSTICS_TOOLS, type DiagnosticsToolInputSchema } from "./registry";

export interface DiagnosticsToolProviderDefinition {
  name: string;
  description: string;
  input_schema: DiagnosticsToolInputSchema;
}

/**
 * The definitions this caller may be offered. Filtered by the SAME `AND`
 * predicate the executor authorizes with, from a matrix the caller must have
 * re-read freshly themselves (AID-7 reads it once per question to build this
 * list; `invoke.ts` re-reads it per call regardless).
 */
export function listDiagnosticsToolDefinitions(
  matrix: AdminPermissionMatrix,
): DiagnosticsToolProviderDefinition[] {
  return DIAGNOSTICS_TOOLS.filter((tool) =>
    hasAllAreaViews(matrix, tool.requiredAreas),
  ).map((tool) => ({
    name: tool.id,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/** The registry ids withheld from this caller. Audit/diagnostic use only. */
export function listWithheldDiagnosticsToolIds(
  matrix: AdminPermissionMatrix,
): string[] {
  return DIAGNOSTICS_TOOLS.filter(
    (tool) => !hasAllAreaViews(matrix, tool.requiredAreas),
  ).map((tool) => tool.id);
}

/**
 * The sentence AID-7 (#2378) shows an operator when every tool was withheld.
 * Plain English, no tool ids: naming tools an operator cannot run invites them to
 * ask for them by name and be refused, which is a worse experience than being
 * told what to do about it.
 */
export const DIAGNOSTICS_NO_TOOLS_AVAILABLE_NOTICE =
  "Your admin access does not currently include any area that the diagnostics data tools read, so this answer is based only on the deployed code and the page you are on. Ask a Full Admin if you need data access added.";
