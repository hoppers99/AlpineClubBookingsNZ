/**
 * AI Diagnostics — the SHARED EVIDENCE-STATE vocabulary (AID-6A, #2375; contracts
 * in ADR-002 §3, ADR-003 §2).
 *
 * One stable code per outcome, for every tool pack. This exists because the
 * distinction the product depends on is not "did we get rows" but "WHY not":
 *
 *   no evidence exists  ≠  the administrator was not permitted to retrieve it
 *   ≠  this deployment is not configured for it  ≠  we could not tell.
 *
 * A model shown an empty result with no state will confidently narrate the most
 * plausible of those four, and three of them would be wrong. #2375 therefore
 * requires stable result states rather than ambiguous empty results, and requires
 * that a permission denial be REPORTED as a denial and never worked around by
 * inferring the answer from a source the caller does happen to hold.
 *
 * WHERE THE STATES COME FROM. `evidenceStateForToolResult` is a TOTAL map over the
 * executor's own failure reasons, so a new reason cannot compile until somebody has
 * decided which state an operator and the model should see. That is deliberately the
 * same discipline `authorize.ts` uses for actor-read failures.
 *
 * WHAT THIS MODULE IS NOT. It is not a place to put prose for the model to read
 * back. The English descriptions here are operator-facing and server-owned; the
 * codes are what a caller branches on.
 */

import type {
  DiagnosticsToolFailureReason,
  DiagnosticsToolResult,
} from "../tools/types";

/**
 * Every state a piece of diagnostic evidence can be in, from #2375's list. Ordered
 * roughly best-to-worst so a case summary can pick the worst state it holds.
 */
export const DIAGNOSTICS_EVIDENCE_STATES = [
  /** Evidence was retrieved. */
  "ok",
  /** Retrieved, but only the first N of a longer set. */
  "result_truncated",
  /** The query ran and matched nothing. The record or event does not exist. */
  "not_found",
  /** More than one record matched; the operator must choose one. */
  "ambiguous",
  /**
   * Retrieved, but as at an instant old enough that it may have moved on.
   *
   * WHO PRODUCES IT, stated as plainly as `provider_check_required` below,
   * because a shipped code with no producer is a code a caller will assume
   * something raises (#2377 review). NOTHING in the tool substrate raises it
   * today, and that is a deliberate refusal rather than an omission: every tool
   * read is executed at invocation time and stamped with its own `observedAt`,
   * so a retrieval is never itself stale. Its producer is the CASE layer
   * (AID-7, #2378), which re-shows evidence gathered earlier in a conversation
   * and folds this in with `worstEvidenceState` — the one place where "read
   * earlier" is a fact somebody holds.
   *
   * IT IS NOT THE CODE FOR AN OLD PROVIDER STATE, and using it that way would be
   * the worse mistake. This schema stores no "provider status last confirmed at"
   * instant anywhere — `updatedAt` is when any column changed — so a staleness
   * rule over stored provider evidence could only be invented, and an invented
   * one presented as a measurement is exactly what this vocabulary exists to
   * prevent. `provider_check_required` is that answer instead: it says the
   * question needs the provider's own console, which is true and actionable,
   * where "this looks stale" would be a guess.
   */
  "stale",
  /** The evidence exists but cannot be classified either way. */
  "indeterminate",
  /**
   * Stored evidence was retrieved, and settling the question needs a LIVE provider
   * check that Diagnostics deliberately cannot make (AID-6C, #2377).
   *
   * It is its own state rather than a flavour of `indeterminate` because the
   * operator's next move is specific and nothing else in this vocabulary implies
   * it: open Stripe's or Xero's own console. #2377's first release reads only what
   * this platform already wrote down, so a stored `SUCCEEDED` is the last state
   * recorded and not a live answer, and a model that cannot say so will present
   * one as the other.
   *
   * WHO PRODUCES IT. Not `evidenceStateForToolResult` — the executor cannot know
   * whether a given question turns on live provider truth, and inventing a
   * heuristic there would be exactly the guessing this vocabulary exists to
   * prevent. The producer is the answer loop (`answer/loop.ts`, #2815): where a
   * tool whose `evidenceScope` carries the finance pack's own
   * `STORED_EVIDENCE_DISCLOSURE` returns an otherwise-`ok` block, the loop folds
   * this state in with `worstEvidenceState` — the disclosure text itself is the
   * membership test (`diagnosticsToolRequiresProviderCheck`), pinned to the
   * marked entries by the finance pack's own census, so the marked set cannot
   * drift from what the pack tells the model. The fold is GUARDED on the block
   * asserting `ok` — that guard, not the state ordering, is what lets a
   * truncated or empty read keep its more specific state (this state's index
   * would otherwise beat both under `worstEvidenceState`). The operator's
   * confirm-in-the-provider's-console caveat does not depend on the fold at
   * all: the provenance line keys it on the TOOL, so it rides collapsed (D10)
   * on every answer that used such a read, truncated and empty ones included.
   * Live provider reads themselves remain out of scope until an owner-approved
   * issue designs their security, rate-limit, credential and audit story.
   */
  "provider_check_required",
  /**
   * The evidence exists and this caller may well be permitted to read it, but this
   * question's inclusion does not cover it, so it was not retrieved (AID-7a, #2785;
   * ADR-004 §1).
   *
   * IT SITS BESIDE `permission_denied` AND NOT INSIDE IT. Both are withheld rather
   * than absent — `isWithheldEvidenceState` covers both — but the operator's next move
   * is completely different, and it is the one thing they can fix themselves: select
   * the record, or tick the personal-details box. Folding it into `permission_denied`
   * would tell an administrator who holds every relevant area to go and ask a Full
   * Admin for access, which is both false and unactionable. That is also why
   * `summariseDiagnosticCase` keeps consent refusals OUT of `withheldAreas`: naming an
   * area there would say an area was denied when none was.
   *
   * ITS POPULATION IS FOUR CAUSES, WHICH IS WHY ITS SENTENCE ASSERTS NONE OF THEM
   * (#2785 delta review). Gate 4b refuses when no record could be resolved, when the
   * record is outside this investigation, and when the operator DID select the record
   * and left the personal-details box unticked — and `record_not_included` maps here
   * too. The first version of the description said "this question does not include the
   * record it is about", which is flatly false of the third case: the operator can see
   * the record is included, and being sent back to the record picker leaves the one
   * control that would fix it unnamed. So the sentence names both controls and claims
   * neither, the same correction `actor_blocked` got when it stopped naming areas that
   * unlock nothing.
   */
  "consent_required",
  /**
   * The assistant asked to SEARCH for records and was not allowed to on this
   * question, so no search ran (#2785 review; owner decision #2378 Q2).
   *
   * IT IS NOT `unsupported`, which is where this used to land. "Diagnostics has no
   * tool that can answer that" is the opposite of the truth here: the tool exists,
   * the operator holds the permission, and one tick turns it on. Telling them
   * otherwise sends a fixable question away as unanswerable, and makes a withheld
   * capability indistinguishable from a hallucinated tool id.
   *
   * IT IS NOT `consent_required` EITHER, and merging them would be the other
   * mistake: that state's remedy is "select the record this is about", which is not
   * the move here. Two withholdings, two controls, two sentences.
   */
  "search_consent_required",
  /** The caller lacks `view` on an area this evidence needs. NEVER inferred around. */
  "permission_denied",
  /** The acting admin account is locked out of the admin surface entirely. */
  "actor_blocked",
  /** No tool in this deployment can answer that question. */
  "unsupported",
  /** The feature is not set up in this deployment (credential, budget, role). */
  "not_configured",
  /** Configured, but a readiness gate is currently failing. */
  "not_ready",
  /** A bound was hit: too many rows, too many bytes, or the call allowance. */
  "limit_exceeded",
  /** A transient fault. Retrying later is reasonable. */
  "temporarily_unavailable",
  /** The evidence source itself refused or did not answer. */
  "evidence_unavailable",
  /** The tool ran and failed in a way that is a defect, not a condition. */
  "tool_failed",
] as const;

export type DiagnosticsEvidenceState =
  (typeof DIAGNOSTICS_EVIDENCE_STATES)[number];

/**
 * Operator-facing sentence per state. Server-owned, never interpolated with caller
 * input, and the same words the UI (AID-7, #2378) and the evidence block use — so
 * an operator reading the transcript and an operator reading the screen are told
 * the same thing.
 */
export const DIAGNOSTICS_EVIDENCE_STATE_DESCRIPTIONS: Record<
  DiagnosticsEvidenceState,
  string
> = {
  ok: "Evidence was retrieved.",
  // Worded to cover BOTH causes of an incomplete set, because there are two and the
  // operator's move is the same for either: the source had more rows than the tool's
  // row limit, or the evidence block could not list every row it was given (see
  // `renderToolResultEvidence`). "Only the first part … was retrieved" was true of the
  // first and wrong about the second.
  result_truncated:
    "Only part of a longer result is here, so this is not a complete set.",
  not_found: "Nothing matched, so there is no evidence of this to report.",
  ambiguous:
    "More than one record matched, so a specific one has to be chosen before it can be investigated.",
  stale:
    "The evidence was read earlier and may have changed since; treat it as of its observed-at time.",
  indeterminate:
    "The evidence was retrieved but does not settle the question either way.",
  provider_check_required:
    "This is what the platform last recorded, not a live answer from the provider. Settling it needs a check in Stripe's or Xero's own console, which Diagnostics deliberately cannot make.",
  // Worded to be true of ALL FOUR causes that land here, because the state cannot tell
  // them apart and a sentence that picks one is wrong for the others (#2785 delta
  // review): the record may not be included, or it may be included with the
  // personal-details box left unticked. Naming both controls and asserting neither
  // cause is the honest version — the earlier "this question does not include the
  // record it is about" told an operator looking at their own selected record that
  // they had not selected it.
  consent_required:
    "The evidence behind this was not retrieved: either this question does not include the record it is about, or it does not allow that record's personal details to be read. Select the record, and tick “Include the personal details of the records I selected” if what you asked for needs them.",
  search_consent_required:
    "The assistant was not allowed to search for people or records on this question, so it did not look. Tick “Let the assistant search for people and records” if you want it to.",
  permission_denied:
    "Your admin access does not include the area this evidence comes from, so it was not retrieved and was not inferred from anywhere else.",
  actor_blocked:
    "Your admin account is currently locked out, so no evidence was retrieved.",
  unsupported: "Diagnostics has no tool that can answer that.",
  not_configured:
    "This part of diagnostics is not set up in this deployment yet.",
  not_ready:
    "Diagnostics is configured but not currently ready, so this evidence was not retrieved.",
  limit_exceeded:
    "This question asks for more than diagnostics is allowed to retrieve at once. Narrow it.",
  temporarily_unavailable:
    "The evidence could not be retrieved just now. Trying again shortly is reasonable.",
  evidence_unavailable:
    "The system evidence behind this could not be gathered, so there is nothing to report.",
  tool_failed:
    "That diagnostics read did not complete, so no evidence is available from it.",
};

/**
 * The TOTAL map from an executor failure reason to the state a caller sees.
 *
 * A few of the choices are worth defending, because each collapses or separates
 * something on purpose:
 *
 *  - `permission_denied` stays its own state, never folded into "unavailable". It is
 *    the one outcome whose correct handling is "say which permission is missing and
 *    stop", and blurring it is exactly how a model ends up guessing the answer.
 *  - `unknown_tool` becomes `unsupported`, not `tool_failed`. To the operator it
 *    means "diagnostics cannot do that", which is a true and useful statement; to
 *    the audit trail it stays `unknown_tool`, which is the forensic detail.
 *  - `database_not_configured` and `database_role_unsafe` split into
 *    `not_configured` and `not_ready`. Both are operator actions, but one is "you
 *    have not set this up" and the other is "you set it up and it has drifted".
 *  - `call_budget_exhausted` and `result_too_large` both become `limit_exceeded`:
 *    the operator's move for either is to ask a narrower question.
 *  - `metering_unavailable`, `actor_read_failed` and `audit_unavailable` become
 *    `temporarily_unavailable` — all three are faults in a dependency that a later
 *    attempt may well not hit — while `redaction_failed` and `internal_error` become
 *    `tool_failed`, because those are defects and retrying is not the remedy.
 *  - `operator_action_required` becomes `search_consent_required`, its OWN state.
 *    It was `unsupported` in the first cut of #2785, on the argument that "to the
 *    model, diagnostics has no tool for this is exactly true" — but these sentences
 *    are operator-facing by their own contract (see
 *    `DIAGNOSTICS_EVIDENCE_STATE_DESCRIPTIONS`), the UI and the evidence block show
 *    the same words, and telling an operator their question is unanswerable when one
 *    tick would answer it is the same defect this issue fixed for the record gate.
 *    `consent_required` stays separate from it because the two remedies differ.
 *  - `evidence_database_busy` becomes `temporarily_unavailable`, NOT
 *    `evidence_unavailable` (#2804). It joins `metering_unavailable` and friends
 *    for the reason that group exists: a later attempt may well not hit it. The
 *    database was reachable and every connection was simply in use, so nothing is
 *    configured wrongly and nothing has drifted — mapping it to
 *    `evidence_unavailable` would tell an operator the evidence could not be
 *    gathered, when the truthful answer is that it was not attempted yet.
 *  - `record_not_included` becomes `consent_required`, the same state as
 *    `sensitive_consent_required`. The refusals differ in what the entry would have
 *    returned — codes and instants versus personal details — but the operator's move
 *    is identical (select the record), and the case layer names remedies.
 */
const EVIDENCE_STATE_FOR_FAILURE: Record<
  DiagnosticsToolFailureReason,
  DiagnosticsEvidenceState
> = {
  unknown_tool: "unsupported",
  invalid_args: "unsupported",
  call_budget_exhausted: "limit_exceeded",
  metering_unavailable: "temporarily_unavailable",
  actor_unresolved: "permission_denied",
  actor_blocked: "actor_blocked",
  actor_read_failed: "temporarily_unavailable",
  permission_denied: "permission_denied",
  sensitive_consent_required: "consent_required",
  record_not_included: "consent_required",
  operator_action_required: "search_consent_required",
  database_not_configured: "not_configured",
  database_role_unsafe: "not_ready",
  database_grants_missing: "not_ready",
  query_failed: "tool_failed",
  evidence_unavailable: "evidence_unavailable",
  evidence_database_busy: "temporarily_unavailable",
  result_too_large: "limit_exceeded",
  redaction_failed: "tool_failed",
  audit_unavailable: "temporarily_unavailable",
  internal_error: "tool_failed",
};

/**
 * The stable state for what the executor RETRIEVED — success, truncation and failure
 * alike.
 *
 * RETRIEVAL IS NOT PRESENTATION, and conflating the two is how the block came to
 * contradict itself. `truncated` here means the SOURCE returned more rows than the
 * tool's `rowLimit`. It says nothing about whether the rendered evidence block could
 * list the rows it was handed — the block has its own character cap and drops whole
 * rows to stay under it. A caller that renders a result for a model must therefore use
 * `renderToolResultEvidence`, which returns the state the block itself asserts: this
 * state, raised to `result_truncated` when the listing is short. Using this function's
 * answer beside a clipped block is what produced `evidence-state="ok"` above
 * `rows (22 of 24 listed …)`.
 */
export function evidenceStateForToolResult(
  result: DiagnosticsToolResult,
): DiagnosticsEvidenceState {
  if (result.status === "error") {
    return EVIDENCE_STATE_FOR_FAILURE[result.reason];
  }
  if (result.truncated) return "result_truncated";
  // A successful read that matched nothing is `not_found`, not `ok`: "we looked and
  // there is nothing" is a different fact from "here is what we found", and the
  // model must not present the first as the second.
  if (result.rows.length === 0) return "not_found";
  return "ok";
}

/**
 * The WORSE of two states, by the declared best-to-worst order of
 * `DIAGNOSTICS_EVIDENCE_STATES`.
 *
 * It exists so a second state can be folded in without letting anything be laundered.
 * The case recorder takes the state the model was actually shown (a block that clipped
 * its rows asserts `result_truncated` where the retrieval was `ok`) and combines it
 * this way, so a caller can only ever make a case's own account of itself MORE
 * qualified — never turn a denial or a truncation back into "evidence was retrieved".
 */
export function worstEvidenceState(
  first: DiagnosticsEvidenceState,
  second: DiagnosticsEvidenceState,
): DiagnosticsEvidenceState {
  return DIAGNOSTICS_EVIDENCE_STATES.indexOf(second) >
    DIAGNOSTICS_EVIDENCE_STATES.indexOf(first)
    ? second
    : first;
}

/**
 * True when a state means the evidence was WITHHELD from this caller rather than
 * absent from the system. The distinction a case summary must not lose: an
 * investigation that hit one of these is INCOMPLETE, and saying so is the honest
 * answer — not filling the gap from a source the caller does hold.
 *
 * `consent_required` and `search_consent_required` are withheld too (AID-7a, #2785):
 * the evidence exists and was deliberately not retrieved. What separates them from
 * the other two is WHOSE decision withheld it and what fixes it — see
 * `isConsentWithheldEvidenceState` and `isSearchWithheldEvidenceState`.
 */
export function isWithheldEvidenceState(
  state: DiagnosticsEvidenceState,
): boolean {
  return (
    state === "permission_denied" ||
    state === "actor_blocked" ||
    state === "consent_required" ||
    state === "search_consent_required"
  );
}

/**
 * True when the state means the evidence was withheld by the OPERATOR'S OWN
 * inclusion decision rather than by a permission (AID-7a, #2785).
 *
 * It exists as a named predicate rather than a `=== "consent_required"` written out
 * at each call site so the case layer and this vocabulary cannot drift: a caller that
 * reports withheld evidence has to decide, at the point of use, whether it is naming
 * a missing PERMISSION or a missing INCLUSION. `summariseDiagnosticCase` uses it to
 * keep consent refusals out of `withheldAreas` — its fallback populates that list
 * from the source's own required areas, which for a consent refusal would name an
 * area the caller was never denied.
 */
export function isConsentWithheldEvidenceState(
  state: DiagnosticsEvidenceState,
): boolean {
  return state === "consent_required";
}

/**
 * True when the state means the evidence was withheld because the operator did not
 * allow the assistant to SEARCH on this question (#2785 review; owner decision #2378
 * Q2).
 *
 * The third member of the same family as `isConsentWithheldEvidenceState`, and it
 * exists for the same reason: a caller reporting withheld evidence has to name a
 * remedy, and there are now three different ones. This one is a tick, not an area
 * and not a record — so `summariseDiagnosticCase` keeps it out of `withheldAreas`
 * exactly as it keeps consent refusals out, and surfaces it as `hasSearchWithheld`.
 */
export function isSearchWithheldEvidenceState(
  state: DiagnosticsEvidenceState,
): boolean {
  return state === "search_consent_required";
}
