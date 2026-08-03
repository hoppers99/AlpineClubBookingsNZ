/**
 * The loop bound is what stops one operator question turning into an unbounded
 * run of paid provider calls and database reads (ADR-005 §3), so these tests
 * check the boundaries rather than the happy path: the last allowed call, the
 * first refused one, and the two ways a caller might try to widen the bound.
 */
import { describe, expect, it } from "vitest";

import { DIAGNOSTICS_MAX_TOOL_ROUNDS } from "@/lib/ai-diagnostics-usage";

import {
  createDiagnosticsToolSession,
  DIAGNOSTICS_TOOL_SESSION_LIMITS,
} from "../session";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";

describe("diagnostics tool session bounds (#2374, ADR-005 §3)", () => {
  it("takes its round bound from AID-2's metered round cap", () => {
    // One number, one owner: the bound that governs spend also governs the loop.
    expect(DIAGNOSTICS_TOOL_SESSION_LIMITS.maxRounds).toBe(
      DIAGNOSTICS_MAX_TOOL_ROUNDS,
    );
    expect(DIAGNOSTICS_TOOL_SESSION_LIMITS.maxToolCallsPerRound).toBe(
      DIAGNOSTICS_TOOL_BOUNDS.maxToolCallsPerRound,
    );
    expect(DIAGNOSTICS_TOOL_SESSION_LIMITS.maxToolCallsPerSession).toBe(
      DIAGNOSTICS_TOOL_BOUNDS.maxToolCallsPerSession,
    );
  });

  it("grants nothing before a round is opened", () => {
    const session = createDiagnosticsToolSession();
    const claim = session.claimToolCall();
    expect(claim).toEqual({ ok: false, reason: "call_budget_exhausted" });
    expect(session.stats().callsThisSession).toBe(0);
  });

  it("allows exactly maxToolCallsPerRound calls in one round", () => {
    const session = createDiagnosticsToolSession({ maxToolCallsPerRound: 2 });
    expect(session.beginRound()).toEqual({ ok: true, roundIndex: 0 });
    expect(session.claimToolCall().ok).toBe(true);
    expect(session.claimToolCall().ok).toBe(true);
    expect(session.claimToolCall()).toEqual({
      ok: false,
      reason: "call_budget_exhausted",
    });
  });

  it("resets the per-round allowance on the next round but not the session total", () => {
    const session = createDiagnosticsToolSession({
      maxToolCallsPerRound: 1,
      maxToolCallsPerSession: 2,
    });
    session.beginRound();
    expect(session.claimToolCall().ok).toBe(true);
    expect(session.claimToolCall().ok).toBe(false);

    expect(session.beginRound()).toEqual({ ok: true, roundIndex: 1 });
    expect(session.claimToolCall()).toEqual({ ok: true, roundIndex: 1 });

    // Session total spent, even though a fresh round has per-round allowance.
    session.beginRound();
    expect(session.claimToolCall()).toEqual({
      ok: false,
      reason: "call_budget_exhausted",
    });
    expect(session.stats().callsThisSession).toBe(2);
  });

  it("allows exactly maxRounds rounds and then refuses", () => {
    const session = createDiagnosticsToolSession({ maxRounds: 3 });
    expect(session.beginRound()).toEqual({ ok: true, roundIndex: 0 });
    expect(session.beginRound()).toEqual({ ok: true, roundIndex: 1 });
    expect(session.beginRound()).toEqual({ ok: true, roundIndex: 2 });
    expect(session.beginRound()).toEqual({
      ok: false,
      reason: "round_limit_exceeded",
    });
    expect(session.stats().roundsStarted).toBe(3);
  });

  it("clamps an override DOWN and never up", () => {
    const session = createDiagnosticsToolSession({
      maxRounds: 9_999,
      maxToolCallsPerRound: 9_999,
      maxToolCallsPerSession: 9_999,
    });
    expect(session.limits).toEqual(DIAGNOSTICS_TOOL_SESSION_LIMITS);
  });

  // Nonsense normalises to ZERO, not to the ceiling: an unreadable bound means we
  // cannot prove the loop is bounded, so nothing is granted.
  it.each([
    [-1, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [2.9, 2],
  ])("normalises a round override of %s to %s", (requested, expected) => {
    const session = createDiagnosticsToolSession({ maxRounds: requested });
    expect(session.limits.maxRounds).toBe(expected);
  });

  it("refuses every round when the bound is zero", () => {
    const session = createDiagnosticsToolSession({ maxRounds: 0 });
    expect(session.beginRound()).toEqual({
      ok: false,
      reason: "round_limit_exceeded",
    });
  });

  it("does not share state between two sessions", () => {
    const first = createDiagnosticsToolSession({ maxToolCallsPerSession: 1 });
    const second = createDiagnosticsToolSession({ maxToolCallsPerSession: 1 });
    first.beginRound();
    second.beginRound();
    expect(first.claimToolCall().ok).toBe(true);
    // One operator's spent allowance must never affect another's.
    expect(second.claimToolCall().ok).toBe(true);
  });
});
