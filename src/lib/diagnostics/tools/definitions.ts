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
 * THE SAME IS TRUE OF THE CONSENT FILTERING added in AID-7a (#2785). A search entry
 * is withheld on a request whose operator did not tick the people-search box, and a
 * personal-data entry is withheld where no record consent was given — but an
 * invocation naming either one is refused by `invoke.ts` gates 4a/4b regardless, and
 * those refusals are the control. This is here so the model does not spend a round
 * proposing tools that were always going to refuse.
 *
 * The shape returned is the Anthropic tool-definition shape (`name`,
 * `description`, `input_schema`), built from server-owned registry text. No
 * operator input, model output or database value is interpolated into it.
 */

import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

import { hasAllAreaViews } from "../page-context/authorize";
import {
  declaresConsentRecord,
  type DiagnosticsConsentLedger,
} from "./consent";
import type { DiagnosticsToolEntry, DiagnosticsToolInputSchema } from "./define";
import { DIAGNOSTICS_TOOLS } from "./registry";

export interface DiagnosticsToolProviderDefinition {
  name: string;
  description: string;
  input_schema: DiagnosticsToolInputSchema;
}

/**
 * Whether an entry is worth OFFERING on this request — permissions, plus the
 * operator's consent decisions (AID-7a, #2785).
 *
 * STILL COURTESY, STILL NOT SECURITY, and the consent additions do not change that:
 * `invoke.ts` gates 3, 4a and 4b run on every invocation whether the definition was
 * offered or not. What this buys is that the model is not shown a search tool on a
 * request where searching is off, or a per-record tool on a request whose
 * investigation holds no record for it to be about — so it does not spend the round
 * proposing refusals and then narrating them.
 */
function isOfferable(
  tool: DiagnosticsToolEntry,
  matrix: AdminPermissionMatrix,
  consent: DiagnosticsConsentLedger,
): boolean {
  if (!hasAllAreaViews(matrix, tool.requiredAreas)) return false;
  if (tool.operatorOnly === true) return consent.peopleSearchGranted;
  // AN EMPTY INVESTIGATION OFFERS NO PER-RECORD ENTRY, whatever the tick says
  // (#2785 review). Search results are never absorbed into the ledger — rule 1 is
  // that the operator chooses the subjects, not the model — so on a request with
  // both boxes ticked and NO record selected, every per-record entry is guaranteed
  // to refuse the ids a search just returned. Offering them anyway spent the round
  // proposing refusals and then narrating them, which is the exact failure this
  // filter exists to avoid. `size` counts operator selections and anything derived
  // from them, so the moment the investigation has a record they are offered again.
  if (declaresConsentRecord(tool)) {
    if (consent.size === 0) return false;
    return tool.surfacesPersonalData ? consent.recordConsentGranted : true;
  }
  if (tool.surfacesPersonalData) return consent.recordConsentGranted;
  return true;
}

/**
 * The definitions this caller may be offered. Filtered by the SAME `AND`
 * predicate the executor authorizes with, from a matrix the caller must have
 * re-read freshly themselves (AID-7 reads it once per question to build this
 * list; `invoke.ts` re-reads it per call regardless), and by this request's own
 * consent state.
 *
 * `consent` is REQUIRED rather than optional: an omitted ledger would silently
 * offer every sensitive entry on a request that consented to none, which is the
 * failure mode this parameter exists to prevent.
 */
export function listDiagnosticsToolDefinitions(
  matrix: AdminPermissionMatrix,
  consent: DiagnosticsConsentLedger,
): DiagnosticsToolProviderDefinition[] {
  return DIAGNOSTICS_TOOLS.filter((tool) =>
    isOfferable(tool, matrix, consent),
  ).map((tool) => ({
    name: tool.id,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/** The registry ids withheld from this caller. Audit/diagnostic use only. */
export function listWithheldDiagnosticsToolIds(
  matrix: AdminPermissionMatrix,
  consent: DiagnosticsConsentLedger,
): string[] {
  return DIAGNOSTICS_TOOLS.filter(
    (tool) => !isOfferable(tool, matrix, consent),
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
