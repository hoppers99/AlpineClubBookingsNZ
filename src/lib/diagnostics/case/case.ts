/**
 * AI Diagnostics — the SHARED DIAGNOSTIC-CASE contract (AID-6A, #2375).
 *
 * ONE investigation, contributed to by SEVERAL tool packs. An administrator asking
 * "why can this booking not be confirmed?" is answered by booking evidence
 * (AID-6B, #2376), finance evidence (AID-6C, #2377) and system evidence (this pack)
 * together — under whichever areas that administrator actually holds. This module
 * is the shape they all write into, and it exists in AID-6A because #2375 owns the
 * shared contracts the later packs plug into without touching the security
 * substrate.
 *
 * WHY A CONTRACT AND NOT JUST ROWS. #2375's product requirement is explicit that
 * Diagnostics "must not merely return database rows and leave the AI to reconstruct
 * complex business rules from incomplete facts". The two properties that follow from
 * that are what this file encodes:
 *
 *  1. A BLOCKER IS AUTHORITATIVE OR IT IS NOT. `confidence` is a required field on
 *     every fact and blocker, and `"inferred"` is one of its values. A model may
 *     report an inference; it may not present one as a rule result. Keeping the
 *     classification on the datum rather than in the prose is what makes that
 *     checkable.
 *  2. AN INCOMPLETE CASE SAYS SO. Every tool result folded in is recorded as a
 *     consulted source WITH its evidence state, so a case that was denied one area
 *     carries that denial rather than a gap. `summariseDiagnosticCase` reports it,
 *     and `withheldAreas` names the permissions that would complete the picture.
 *
 * PURE. No IO, no clock, no database, no model call — the observed-at instants come
 * from the tool results being folded in. That keeps it exhaustively testable and
 * keeps the security controls where they already are: in `invoke.ts`.
 */

import type { AdminPermissionArea } from "@/lib/admin-permissions";

import type { DiagnosticsToolResult } from "../tools/types";
import {
  evidenceStateForToolResult,
  isWithheldEvidenceState,
  type DiagnosticsEvidenceState,
} from "./states";

/**
 * How much weight a fact or blocker carries. The distinction #2375 requires the
 * agent to preserve, made a field rather than a tone of voice.
 */
export type DiagnosticEvidenceConfidence =
  /** Read from an authoritative source and true as at its observed-at instant. */
  | "confirmed_current"
  /** A recorded past event. True then; says nothing about now. */
  | "historical"
  /** The application's own rule engine said this blocks the action. */
  | "authoritative_blocker"
  /** A likely cause the evidence suggests. NEVER to be reported as a rule result. */
  | "inferred";

/** What kind of record an investigation is about. Extended by the domain packs. */
export type DiagnosticRecordType =
  | "booking"
  | "member"
  | "payment"
  | "family_group"
  | "lodge"
  | "system";

/**
 * A reference to a record, as evidence carries it. `label` is what an operator
 * recognises (a booking reference, a member number); `ref` is the identifier the
 * admin UI needs to open it. Both are OPTIONAL because a tool may legitimately know
 * only the kind of record — and because a pack must never invent an identifier it
 * was not permitted to read.
 */
export interface DiagnosticRecordRef {
  type: DiagnosticRecordType;
  label?: string;
  ref?: string;
}

/** One fact, blocker or warning. `code` is stable; `statement` is plain English. */
export interface DiagnosticFinding {
  code: string;
  statement: string;
  confidence: DiagnosticEvidenceConfidence;
  /** The instant the underlying evidence was read. ISO-8601. */
  observedAt: string;
  record?: DiagnosticRecordRef;
}

/** An evidence source this case consulted, and what came back. */
export interface DiagnosticEvidenceSourceOutcome {
  /** The registry key of the tool that was run. */
  toolId: string;
  state: DiagnosticsEvidenceState;
  /** Areas the tool required. Recorded even — especially — when it was denied. */
  areas: readonly AdminPermissionArea[];
  /** Populated only for a permission denial. */
  missingAreas: readonly AdminPermissionArea[];
  rowCount: number;
  observedAt: string;
}

/** A suggested next step. Diagnostics never performs one; it recommends it. */
export interface DiagnosticNextAction {
  code: string;
  /** Plain English, imperative. Always a recommendation, never a claim. */
  statement: string;
  /** Who has to do it. */
  actor: "administrator" | "member" | "another_administrator";
  /** The area permission the actor needs, when that is the obstacle. */
  requiresArea?: AdminPermissionArea;
  /** A server-constructed link to an existing admin screen. Never built from input. */
  adminPath?: string;
}

/** One investigation, as the packs build it up. */
export interface DiagnosticCase {
  /** What was asked, as a stable code (e.g. `booking.cannot_confirm`). */
  investigation: string;
  /** The record the investigation is about, when one was selected. */
  primaryRecord?: DiagnosticRecordRef;
  /** The authoritative current state of that record, when a pack established it. */
  currentState?: DiagnosticFinding;
  blockers: DiagnosticFinding[];
  warnings: DiagnosticFinding[];
  facts: DiagnosticFinding[];
  /** Recorded past events, kept apart from current facts on purpose. */
  history: DiagnosticFinding[];
  relatedRecords: DiagnosticRecordRef[];
  sources: DiagnosticEvidenceSourceOutcome[];
  nextActions: DiagnosticNextAction[];
  /** The earliest observed-at across the evidence folded in, or null when none. */
  earliestObservedAt: string | null;
  /** The latest observed-at across the evidence folded in, or null when none. */
  latestObservedAt: string | null;
}

/** A fresh, empty case. */
export function createDiagnosticCase(investigation: string): DiagnosticCase {
  return {
    investigation,
    blockers: [],
    warnings: [],
    facts: [],
    history: [],
    relatedRecords: [],
    sources: [],
    nextActions: [],
    earliestObservedAt: null,
    latestObservedAt: null,
  };
}

/**
 * Record that a tool was consulted, whatever came back. MUTATES the case, which is
 * the point: several packs contribute to one object during one answer.
 *
 * A DENIAL IS AN OUTCOME, NOT AN OMISSION. This is called for a failure exactly as
 * it is for a success, so the case can say "finance evidence was not available to
 * you" instead of quietly containing no finance evidence. `areas` comes from the
 * result's own audit metadata rather than from the caller, so it cannot be
 * misreported as a different tool's requirement.
 */
export function recordCaseEvidence(
  diagnosticCase: DiagnosticCase,
  result: DiagnosticsToolResult,
): DiagnosticEvidenceSourceOutcome {
  const state = evidenceStateForToolResult(result);
  const outcome: DiagnosticEvidenceSourceOutcome = {
    toolId: result.toolId,
    state,
    areas: result.audit.areasChecked,
    missingAreas:
      result.status === "error" ? (result.missingAreas ?? []) : [],
    rowCount: result.status === "ok" ? result.rows.length : 0,
    observedAt: result.observedAt,
  };
  diagnosticCase.sources.push(outcome);

  // Freshness bounds are tracked as strings: every `observedAt` in this substrate is
  // an ISO-8601 UTC instant from `Date.prototype.toISOString`, which is fixed-width,
  // so lexical order IS chronological order and no parsing (or timezone) is involved.
  if (
    diagnosticCase.earliestObservedAt === null ||
    result.observedAt < diagnosticCase.earliestObservedAt
  ) {
    diagnosticCase.earliestObservedAt = result.observedAt;
  }
  if (
    diagnosticCase.latestObservedAt === null ||
    result.observedAt > diagnosticCase.latestObservedAt
  ) {
    diagnosticCase.latestObservedAt = result.observedAt;
  }

  return outcome;
}

export interface DiagnosticCaseSummary {
  /** True only when every consulted source produced evidence. */
  complete: boolean;
  /** True when at least one source was withheld for permissions. */
  hasWithheldEvidence: boolean;
  /** The areas that would unlock the withheld sources, de-duplicated and sorted. */
  withheldAreas: AdminPermissionArea[];
  /** True when at least one blocker is an authoritative rule result. */
  hasAuthoritativeBlocker: boolean;
  /** True when a blocker is only inferred — the model must not overstate it. */
  hasInferredBlockerOnly: boolean;
  /** The states seen across all sources, de-duplicated and sorted. */
  states: DiagnosticsEvidenceState[];
}

/**
 * Summarise what a case does and does not establish.
 *
 * `hasInferredBlockerOnly` is the field that guards #2375's rule "do not allow the
 * model to present an inference as though it were an authoritative rule result": a
 * caller (AID-7, #2378) can use it to frame the answer as a likely cause rather than
 * a verdict, without having to re-read every finding.
 */
export function summariseDiagnosticCase(
  diagnosticCase: DiagnosticCase,
): DiagnosticCaseSummary {
  const withheld = diagnosticCase.sources.filter((source) =>
    isWithheldEvidenceState(source.state),
  );
  const withheldAreas = [
    ...new Set(
      withheld.flatMap((source) =>
        source.missingAreas.length > 0 ? source.missingAreas : source.areas,
      ),
    ),
  ].sort();

  const blockerConfidences = new Set(
    diagnosticCase.blockers.map((blocker) => blocker.confidence),
  );

  return {
    complete: diagnosticCase.sources.every(
      (source) => source.state === "ok" || source.state === "not_found",
    ),
    hasWithheldEvidence: withheld.length > 0,
    withheldAreas,
    hasAuthoritativeBlocker: blockerConfidences.has("authoritative_blocker"),
    hasInferredBlockerOnly:
      diagnosticCase.blockers.length > 0 &&
      !blockerConfidences.has("authoritative_blocker"),
    states: [...new Set(diagnosticCase.sources.map((source) => source.state))].sort(),
  };
}
