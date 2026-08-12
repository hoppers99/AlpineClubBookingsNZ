/**
 * THE COLLAPSED PROVENANCE LINE (AID-7, #2378; owner decision D10).
 *
 * D10 laid down exactly one binding rule about this line, and it is the rule these
 * tests exist for: "The honesty markers are never dropped from the collapsed line.
 * 'Something could not be read' or 'this was stale' belongs in the one-line summary,
 * not only behind the expander — the expander is for detail, not for the existence of
 * a caveat."
 *
 * So every case below asks the same question in a different shape: given a withheld,
 * truncated or failed source, does the ONE LINE say so?
 */

import { describe, expect, it } from "vitest";

import { summariseDiagnosticCase, type DiagnosticCase } from "../../case/case";
import { buildDiagnosticsProvenance } from "../provenance";
import type { DiagnosticsAskSource } from "../contract";
import {
  DIAGNOSTICS_EVIDENCE_STATE_DESCRIPTIONS,
  type DiagnosticsEvidenceState,
} from "../../case/states";

const NOW = new Date("2026-08-12T12:00:00.000Z");

function source(
  state: DiagnosticsEvidenceState,
  overrides: Partial<DiagnosticsAskSource> = {},
): DiagnosticsAskSource {
  return {
    toolId: "booking_block_state",
    label: "Booking blockers",
    state,
    stateDescription: DIAGNOSTICS_EVIDENCE_STATE_DESCRIPTIONS[state],
    observedAt: "2026-08-12T11:59:00.000Z",
    rowCount: state === "ok" ? 3 : 0,
    missingAreas: [],
    ...overrides,
  };
}

/** A case whose summary reports exactly the given source states. */
function caseWith(
  states: Array<{
    state: DiagnosticsEvidenceState;
    areas?: string[];
    missingAreas?: string[];
  }>,
): DiagnosticCase {
  return {
    investigation: "test",
    blockers: [],
    warnings: [],
    facts: [],
    history: [],
    relatedRecords: [],
    sources: states.map((entry) => ({
      toolId: "t",
      state: entry.state,
      areas: (entry.areas ?? []) as never,
      missingAreas: (entry.missingAreas ?? []) as never,
      rowCount: 0,
      observedAt: "2026-08-12T11:59:00.000Z",
    })),
    nextActions: [],
    earliestObservedAt: null,
    latestObservedAt: null,
  };
}

describe("a clean answer says where it came from (#2378, D10)", () => {
  it("names the tool and how fresh it is, with no caveat", () => {
    const provenance = buildDiagnosticsProvenance({
      sources: [source("ok")],
      summary: summariseDiagnosticCase(caseWith([{ state: "ok" }])),
      roundsUsed: 2,
      now: NOW,
    });
    expect(provenance.line).toBe("Read from Booking blockers, just now.");
    expect(provenance.hasCaveat).toBe(false);
  });

  it("says so plainly when no tool ran at all", () => {
    // "Based on the deployed code" is a materially different answer from "read from
    // live booking data", and the operator is deciding whether to trust it.
    const provenance = buildDiagnosticsProvenance({
      sources: [],
      summary: summariseDiagnosticCase(caseWith([])),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.line).toContain("No live data was read");
    expect(provenance.hasCaveat).toBe(false);
  });

  it("collapses several tools rather than listing them all", () => {
    // A narrow column is D10's whole premise; a line naming six tools is the
    // metadata-taller-than-the-answer failure it rejected.
    const provenance = buildDiagnosticsProvenance({
      sources: [
        source("ok", { label: "A" }),
        source("ok", { label: "B" }),
        source("ok", { label: "C" }),
        source("ok", { label: "D" }),
      ],
      summary: summariseDiagnosticCase(
        caseWith([{ state: "ok" }, { state: "ok" }, { state: "ok" }, { state: "ok" }]),
      ),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.line).toContain("A, B and 2 more");
  });
});

describe("the caveat is never dropped from the collapsed line (#2378, D10)", () => {
  it("names the missing AREA for a permission denial", () => {
    const provenance = buildDiagnosticsProvenance({
      sources: [source("ok"), source("permission_denied", { missingAreas: ["finance"] })],
      summary: summariseDiagnosticCase(
        caseWith([
          { state: "ok" },
          { state: "permission_denied", missingAreas: ["finance"] },
        ]),
      ),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.hasCaveat).toBe(true);
    expect(provenance.hasPermissionWithheld).toBe(true);
    expect(provenance.line).toContain("could not be read with your admin access");
    expect(provenance.line).toContain("finance");
  });

  it("names the INCLUSION, not an area, for a consent refusal", () => {
    // `states.ts` is emphatic that merging these misdirects the operator: naming an
    // area here would tell an admin who holds every relevant permission to go and ask
    // a Full Admin for access.
    const provenance = buildDiagnosticsProvenance({
      sources: [source("consent_required")],
      summary: summariseDiagnosticCase(caseWith([{ state: "consent_required" }])),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.hasConsentWithheld).toBe(true);
    expect(provenance.line).toContain("did not include it");
    expect(provenance.withheldAreas).toEqual([]);
  });

  it("names the SEARCH tick for a search refusal", () => {
    const provenance = buildDiagnosticsProvenance({
      sources: [source("search_consent_required")],
      summary: summariseDiagnosticCase(caseWith([{ state: "search_consent_required" }])),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.hasSearchWithheld).toBe(true);
    expect(provenance.line).toContain("search was not allowed");
    expect(provenance.withheldAreas).toEqual([]);
  });

  it("says a longer result was cut", () => {
    const provenance = buildDiagnosticsProvenance({
      sources: [source("result_truncated", { rowCount: 200 })],
      summary: summariseDiagnosticCase(caseWith([{ state: "result_truncated" }])),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.hasPartialEvidence).toBe(true);
    expect(provenance.line).toContain("part of a longer result was left out");
  });

  it("carries a caveat for a state with no specific marker", () => {
    // A locked-out actor is counted by `hasWithheldEvidence` but by none of the three
    // specific flags. Testing only those three would drop it from the line entirely.
    const provenance = buildDiagnosticsProvenance({
      sources: [source("actor_blocked")],
      summary: summariseDiagnosticCase(caseWith([{ state: "actor_blocked" }])),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.hasCaveat).toBe(true);
    expect(provenance.line).toContain("some evidence could not be gathered");
  });

  it("carries a caveat for a tool that simply failed", () => {
    const provenance = buildDiagnosticsProvenance({
      sources: [source("tool_failed")],
      summary: summariseDiagnosticCase(caseWith([{ state: "tool_failed" }])),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.hasCaveat).toBe(true);
    expect(provenance.line).toContain("could not be gathered");
  });

  it("does NOT raise a caveat for an honest empty result", () => {
    // "Nothing matched" is a complete answer, not a caveat. Flagging it would teach
    // operators to ignore the marker, which is how a real caveat gets missed.
    const provenance = buildDiagnosticsProvenance({
      sources: [source("not_found")],
      summary: summariseDiagnosticCase(caseWith([{ state: "not_found" }])),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.hasCaveat).toBe(false);
  });

  it("reports several caveats together rather than only the first", () => {
    const provenance = buildDiagnosticsProvenance({
      sources: [
        source("ok"),
        source("permission_denied", { missingAreas: ["finance"] }),
        source("search_consent_required"),
        source("result_truncated"),
      ],
      summary: summariseDiagnosticCase(
        caseWith([
          { state: "ok" },
          { state: "permission_denied", missingAreas: ["finance"] },
          { state: "search_consent_required" },
          { state: "result_truncated" },
        ]),
      ),
      roundsUsed: 3,
      now: NOW,
    });
    expect(provenance.line).toContain("admin access");
    expect(provenance.line).toContain("search was not allowed");
    expect(provenance.line).toContain("longer result");
  });
});

describe("freshness is coarse in the line (#2378, D10)", () => {
  it("says minutes for older evidence", () => {
    const provenance = buildDiagnosticsProvenance({
      sources: [source("ok", { observedAt: "2026-08-12T11:50:00.000Z" })],
      summary: summariseDiagnosticCase(caseWith([{ state: "ok" }])),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.line).toContain("10 minutes ago");
  });

  it("survives an unparseable instant rather than rendering NaN", () => {
    const provenance = buildDiagnosticsProvenance({
      sources: [source("ok", { observedAt: "not-an-instant" })],
      summary: summariseDiagnosticCase(caseWith([{ state: "ok" }])),
      roundsUsed: 1,
      now: NOW,
    });
    expect(provenance.line).not.toContain("NaN");
  });
});
