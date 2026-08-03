/**
 * AI Diagnostics — the BOUNDED tool loop (AID-5, #2374; contract in ADR-005 §3).
 *
 * A diagnostics answer is an agentic loop: the model asks for a tool, reads the
 * result, and may ask again. Two things have to be finite for that to be safe,
 * and they are different things:
 *
 *  - PROVIDER ROUNDS bound the money. AID-2 already owns that number
 *    (`DIAGNOSTICS_MAX_TOOL_ROUNDS`) because each round reserves budget before it
 *    spends. This module holds the loop to it.
 *  - TOOL CALLS bound the database. A single round can ask for several tools, so
 *    rounds alone do not bound the reads. `maxToolCallsPerRound` and
 *    `maxToolCallsPerSession` do.
 *
 * The session is an explicit object rather than ambient state because the bound
 * must belong to ONE operator's ONE question. A module-level counter would either
 * leak between concurrent admins or reset per process, and both are the kind of
 * "limit that is not really a limit" this exists to avoid.
 *
 * FAIL CLOSED: a claim is only granted when it can be proven to be within every
 * bound. An unstarted session grants nothing.
 */

import { DIAGNOSTICS_MAX_TOOL_ROUNDS } from "@/lib/ai-diagnostics-usage";

import { DIAGNOSTICS_TOOL_BOUNDS } from "./types";

export interface DiagnosticsToolSessionLimits {
  maxRounds: number;
  maxToolCallsPerRound: number;
  maxToolCallsPerSession: number;
}

export const DIAGNOSTICS_TOOL_SESSION_LIMITS: DiagnosticsToolSessionLimits = {
  maxRounds: DIAGNOSTICS_MAX_TOOL_ROUNDS,
  maxToolCallsPerRound: DIAGNOSTICS_TOOL_BOUNDS.maxToolCallsPerRound,
  maxToolCallsPerSession: DIAGNOSTICS_TOOL_BOUNDS.maxToolCallsPerSession,
};

export interface DiagnosticsToolSessionStats {
  roundIndex: number;
  roundsStarted: number;
  callsThisRound: number;
  callsThisSession: number;
}

export interface DiagnosticsToolSession {
  readonly limits: DiagnosticsToolSessionLimits;
  /**
   * Open the next provider round. Called by the answer loop (AID-7, #2378)
   * BEFORE it reserves budget, so an exhausted loop never reserves.
   */
  beginRound(): { ok: true; roundIndex: number } | { ok: false; reason: "round_limit_exceeded" };
  /**
   * Claim one tool invocation inside the current round. Refuses when no round is
   * open, when this round has used its calls, or when the session has.
   */
  claimToolCall():
    | { ok: true; roundIndex: number }
    | { ok: false; reason: "call_budget_exhausted" };
  stats(): DiagnosticsToolSessionStats;
}

/**
 * A fresh, per-question tool session. `limits` is overridable ONLY downwards:
 * an override that tried to raise a bound is clamped to the shipped ceiling, so
 * a caller (or a future route with a config value) cannot widen the loop.
 */
export function createDiagnosticsToolSession(
  overrides: Partial<DiagnosticsToolSessionLimits> = {},
): DiagnosticsToolSession {
  const clamp = (requested: number | undefined, ceiling: number): number => {
    if (requested === undefined) return ceiling;
    const value = Math.trunc(requested);
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.min(value, ceiling);
  };

  const limits: DiagnosticsToolSessionLimits = {
    maxRounds: clamp(overrides.maxRounds, DIAGNOSTICS_TOOL_SESSION_LIMITS.maxRounds),
    maxToolCallsPerRound: clamp(
      overrides.maxToolCallsPerRound,
      DIAGNOSTICS_TOOL_SESSION_LIMITS.maxToolCallsPerRound,
    ),
    maxToolCallsPerSession: clamp(
      overrides.maxToolCallsPerSession,
      DIAGNOSTICS_TOOL_SESSION_LIMITS.maxToolCallsPerSession,
    ),
  };

  // -1 means "no round open yet", so `claimToolCall` before `beginRound` refuses
  // rather than defaulting into round 0.
  let roundIndex = -1;
  let roundsStarted = 0;
  let callsThisRound = 0;
  let callsThisSession = 0;

  return {
    limits,
    beginRound() {
      if (roundsStarted >= limits.maxRounds) {
        return { ok: false, reason: "round_limit_exceeded" };
      }
      roundIndex = roundsStarted;
      roundsStarted += 1;
      callsThisRound = 0;
      return { ok: true, roundIndex };
    },
    claimToolCall() {
      if (roundIndex < 0) return { ok: false, reason: "call_budget_exhausted" };
      if (callsThisRound >= limits.maxToolCallsPerRound) {
        return { ok: false, reason: "call_budget_exhausted" };
      }
      if (callsThisSession >= limits.maxToolCallsPerSession) {
        return { ok: false, reason: "call_budget_exhausted" };
      }
      callsThisRound += 1;
      callsThisSession += 1;
      return { ok: true, roundIndex };
    },
    stats() {
      return { roundIndex, roundsStarted, callsThisRound, callsThisSession };
    },
  };
}
