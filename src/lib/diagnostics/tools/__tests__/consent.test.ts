/**
 * The investigation consent ledger (AID-7a, #2785; ADR-004 §1).
 *
 * The properties here are the ones that make "bounded investigation" a fact rather
 * than a description. Each test below maps to one of the module's four rules, and
 * the negative ones matter more than the positive one: a ledger that grows from
 * model text, from a failed call, from an undeclared field or from a record two hops
 * away is not bounded, and nothing else in the substrate would notice.
 */
import { describe, expect, it } from "vitest";

import {
  DIAGNOSTICS_CONSENT_LEDGER_MAX_ENTRIES,
  DIAGNOSTICS_TOOL_CONSENT_COPY,
  consentedRecordForToolCall,
  createDiagnosticsConsentLedger,
  createEmptyDiagnosticsConsentLedger,
  type DiagnosticsConsentToolDeclaration,
} from "../consent";
import { RECORD_ID } from "../packs/finance-shared";
import { DIAGNOSTICS_CONSENT_RECORD_KINDS } from "../types";

const BOOKING_A = "ckbooking0000000000000001";
const MEMBER_M = "ckmember00000000000000001";
const MEMBER_N = "ckmember00000000000000002";
const PAYMENT_P = "ckpayment0000000000000001";

/** `booking_block_state`'s real declaration shape. */
const BLOCK_STATE: DiagnosticsConsentToolDeclaration = {
  personalDataRecordKind: "booking",
  personalDataRecordArgKey: "bookingId",
  relatedRecordRefs: [{ field: "ownerMemberRef", kind: "member" }],
};

function seeded() {
  return createDiagnosticsConsentLedger({
    recordConsentGranted: true,
    peopleSearchGranted: false,
    selectedRecords: [{ kind: "booking", id: BOOKING_A }],
  });
}

describe("consent ledger — seeding (#2785)", () => {
  it("seeds only from the operator's own selections, and records that provenance", () => {
    const ledger = seeded();
    expect(ledger.has("booking", BOOKING_A)).toBe(true);
    expect(ledger.originOf("booking", BOOKING_A)).toBe("operator_selected");
    expect(ledger.entries()).toEqual([
      {
        kind: "booking",
        id: BOOKING_A,
        origin: "operator_selected",
        derivedFrom: null,
      },
    ]);
  });

  it("consents to nothing by default", () => {
    const ledger = createEmptyDiagnosticsConsentLedger();
    expect(ledger.recordConsentGranted).toBe(false);
    expect(ledger.peopleSearchGranted).toBe(false);
    expect(ledger.size).toBe(0);
    expect(ledger.has("booking", BOOKING_A)).toBe(false);
  });

  it("hands out a NEW empty ledger every time, so consent cannot leak between requests", () => {
    // The one failure this module could not recover from. A shared module-level
    // instance would be mutated by `absorbRelatedRecordRefs` on one request and read
    // by the next.
    const first = createEmptyDiagnosticsConsentLedger();
    const second = createEmptyDiagnosticsConsentLedger();
    expect(first).not.toBe(second);
    createDiagnosticsConsentLedger({
      recordConsentGranted: true,
      peopleSearchGranted: false,
      selectedRecords: [{ kind: "booking", id: BOOKING_A }],
    });
    expect(second.has("booking", BOOKING_A)).toBe(false);
  });

  it("refuses a selection that is not id-shaped, and counts it rather than hiding it", () => {
    const ledger = createDiagnosticsConsentLedger({
      recordConsentGranted: true,
      peopleSearchGranted: false,
      selectedRecords: [
        { kind: "booking", id: BOOKING_A },
        // The projection sentinels and the shapes a hostile client would try.
        { kind: "booking", id: "(unparseable)" },
        { kind: "booking", id: "" },
        { kind: "member", id: "Robert'); DROP TABLE members;--" },
        { kind: "member", id: "SHORT" },
        { kind: "not-a-kind" as "member", id: MEMBER_M },
      ],
    });
    expect(ledger.size).toBe(1);
    expect(ledger.rejectedSelectionCount).toBe(5);
    expect(ledger.has("member", MEMBER_M)).toBe(false);
  });

  it("de-duplicates selections without inflating the rejection count", () => {
    const ledger = createDiagnosticsConsentLedger({
      recordConsentGranted: true,
      peopleSearchGranted: false,
      selectedRecords: [
        { kind: "booking", id: BOOKING_A },
        { kind: "booking", id: BOOKING_A },
      ],
    });
    expect(ledger.size).toBe(1);
    expect(ledger.rejectedSelectionCount).toBe(0);
  });

  it("keeps the two ticks independent — neither implies the other", () => {
    const searchOnly = createDiagnosticsConsentLedger({
      recordConsentGranted: false,
      peopleSearchGranted: true,
      selectedRecords: [],
    });
    expect(searchOnly.recordConsentGranted).toBe(false);
    expect(searchOnly.peopleSearchGranted).toBe(true);
    expect(seeded().peopleSearchGranted).toBe(false);
  });

  it("treats a non-boolean tick as NOT granted", () => {
    // The ticks arrive from a parsed request body. A truthy non-boolean must not
    // become consent.
    const ledger = createDiagnosticsConsentLedger({
      recordConsentGranted: "yes" as unknown as boolean,
      peopleSearchGranted: 1 as unknown as boolean,
      selectedRecords: [],
    });
    expect(ledger.recordConsentGranted).toBe(false);
    expect(ledger.peopleSearchGranted).toBe(false);
  });

  it("pins the cap at a value a reviewer has to argue about to change", () => {
    // The overflow tests below are RELATIVE to this constant, so they pass at any
    // value — including one large enough to be no bound at all. This is the
    // assertion that makes widening it a deliberate, visible act.
    expect(DIAGNOSTICS_CONSENT_LEDGER_MAX_ENTRIES).toBe(128);
  });

  it("caps the ledger and refuses the overflow rather than evicting a selection", () => {
    const many = Array.from(
      { length: DIAGNOSTICS_CONSENT_LEDGER_MAX_ENTRIES + 5 },
      (_unused, index) => ({
        kind: "member" as const,
        id: `ckmember${String(index).padStart(16, "0")}`,
      }),
    );
    const ledger = createDiagnosticsConsentLedger({
      recordConsentGranted: true,
      peopleSearchGranted: false,
      selectedRecords: many,
    });
    expect(ledger.size).toBe(DIAGNOSTICS_CONSENT_LEDGER_MAX_ENTRIES);
    expect(ledger.rejectedSelectionCount).toBe(5);
    // The first selection survived: nothing the operator chose was evicted.
    expect(ledger.has("member", many[0].id)).toBe(true);
  });

  it("hands out copies, so a caller cannot edit the ledger through its own entries", () => {
    const ledger = seeded();
    const entries = ledger.entries();
    entries[0].id = MEMBER_M;
    entries.push({
      kind: "member",
      id: MEMBER_M,
      origin: "operator_selected",
      derivedFrom: null,
    });
    expect(ledger.has("member", MEMBER_M)).toBe(false);
    expect(ledger.has("booking", BOOKING_A)).toBe(true);
  });
});

describe("consent ledger — the record one call is about (#2785)", () => {
  it("reads the record from the accepted arguments the entry declared", () => {
    expect(
      consentedRecordForToolCall(BLOCK_STATE, { bookingId: BOOKING_A }),
    ).toEqual({ kind: "booking", id: BOOKING_A });
  });

  it("returns null — a refusal — when the entry declares no record", () => {
    expect(consentedRecordForToolCall({}, { bookingId: BOOKING_A })).toBeNull();
    expect(
      consentedRecordForToolCall(
        { personalDataRecordKind: "booking" },
        { bookingId: BOOKING_A },
      ),
    ).toBeNull();
  });

  it("returns null when the argument is absent, wrongly shaped or not a string", () => {
    expect(consentedRecordForToolCall(BLOCK_STATE, {})).toBeNull();
    expect(consentedRecordForToolCall(BLOCK_STATE, { bookingId: 7 })).toBeNull();
    expect(
      consentedRecordForToolCall(BLOCK_STATE, { bookingId: "TOO-SHORT" }),
    ).toBeNull();
    expect(consentedRecordForToolCall(BLOCK_STATE, null)).toBeNull();
    expect(consentedRecordForToolCall(BLOCK_STATE, "a string")).toBeNull();
  });

  it("never invokes a getter on the arguments while deciding", () => {
    // The value is read through its property DESCRIPTOR. A getter that ran here
    // would be caller-chosen code executing inside the consent decision.
    let invoked = 0;
    const args = {};
    Object.defineProperty(args, "bookingId", {
      enumerable: true,
      get() {
        invoked += 1;
        return BOOKING_A;
      },
    });
    expect(consentedRecordForToolCall(BLOCK_STATE, args)).toBeNull();
    expect(invoked).toBe(0);
  });
});

describe("consent ledger — absorbing related records (#2785)", () => {
  it("absorbs a DECLARED projected ref from a consented record's own result", () => {
    // The flagship flow: booking B was selected, `booking_block_state(B)` projects the
    // owner, and `member_eligibility_state(M)` is then allowed under the same consent.
    const ledger = seeded();
    const outcome = ledger.absorbRelatedRecordRefs({
      tool: BLOCK_STATE,
      acceptedArgs: { bookingId: BOOKING_A },
      rows: [{ bookingId: BOOKING_A, ownerMemberRef: MEMBER_M }],
    });
    expect(outcome).toEqual({ absorbed: 1, capReached: false });
    expect(ledger.has("member", MEMBER_M)).toBe(true);
    expect(ledger.originOf("member", MEMBER_M)).toBe("derived");
    expect(ledger.entries()).toContainEqual({
      kind: "member",
      id: MEMBER_M,
      origin: "derived",
      derivedFrom: { kind: "booking", id: BOOKING_A },
    });
  });

  it("does NOT absorb a field the entry did not declare", () => {
    const ledger = seeded();
    ledger.absorbRelatedRecordRefs({
      tool: BLOCK_STATE,
      acceptedArgs: { bookingId: BOOKING_A },
      // A perfectly id-shaped value in an undeclared column.
      rows: [{ ownerMemberRef: MEMBER_M, someOtherMemberRef: MEMBER_N }],
    });
    expect(ledger.has("member", MEMBER_M)).toBe(true);
    expect(ledger.has("member", MEMBER_N)).toBe(false);
  });

  it("does NOT absorb when the calling record was never consented", () => {
    const ledger = seeded();
    const outcome = ledger.absorbRelatedRecordRefs({
      tool: BLOCK_STATE,
      // A booking the operator did not select. `invoke.ts` refuses this call before
      // it can produce rows; the ledger refuses it a second time regardless.
      acceptedArgs: { bookingId: "ckbooking0000000000000009" },
      rows: [{ ownerMemberRef: MEMBER_N }],
    });
    expect(outcome.absorbed).toBe(0);
    expect(ledger.has("member", MEMBER_N)).toBe(false);
  });

  it("stops at ONE HOP — a derived record cannot be used to derive further", () => {
    // Rule 3. Without it, one selected booking walks the membership graph: owner ->
    // owner's family -> their bookings -> those owners, one authorised call at a time.
    const ledger = seeded();
    ledger.absorbRelatedRecordRefs({
      tool: BLOCK_STATE,
      acceptedArgs: { bookingId: BOOKING_A },
      rows: [{ ownerMemberRef: MEMBER_M }],
    });
    expect(ledger.originOf("member", MEMBER_M)).toBe("derived");

    const familyState: DiagnosticsConsentToolDeclaration = {
      personalDataRecordKind: "member",
      personalDataRecordArgKey: "memberId",
      relatedRecordRefs: [{ field: "relatedMemberRef", kind: "member" }],
    };
    const outcome = ledger.absorbRelatedRecordRefs({
      tool: familyState,
      acceptedArgs: { memberId: MEMBER_M },
      rows: [{ relatedMemberRef: MEMBER_N }],
    });
    expect(outcome.absorbed).toBe(0);
    expect(ledger.has("member", MEMBER_N)).toBe(false);
  });

  it("does NOT absorb a projection sentinel or an empty ref", () => {
    // `recordRefOrNull` returns `(unparseable)` for a value that is not id-shaped and
    // the entries coalesce a missing ref to `""`. Neither is a record.
    const ledger = seeded();
    const outcome = ledger.absorbRelatedRecordRefs({
      tool: BLOCK_STATE,
      acceptedArgs: { bookingId: BOOKING_A },
      rows: [
        { ownerMemberRef: "(unparseable)" },
        { ownerMemberRef: "" },
        { ownerMemberRef: null },
        { ownerMemberRef: 42 },
      ],
    });
    expect(outcome.absorbed).toBe(0);
    expect(ledger.size).toBe(1);
  });

  it("does not absorb from an entry that declares no related refs", () => {
    const ledger = seeded();
    const outcome = ledger.absorbRelatedRecordRefs({
      tool: {
        personalDataRecordKind: "booking",
        personalDataRecordArgKey: "bookingId",
      },
      acceptedArgs: { bookingId: BOOKING_A },
      rows: [{ ownerMemberRef: MEMBER_M }],
    });
    expect(outcome.absorbed).toBe(0);
    expect(ledger.has("member", MEMBER_M)).toBe(false);
  });

  it("absorbs every declared ref across every row, once each", () => {
    const partyTool: DiagnosticsConsentToolDeclaration = {
      personalDataRecordKind: "booking",
      personalDataRecordArgKey: "bookingId",
      relatedRecordRefs: [{ field: "guestMemberRef", kind: "member" }],
    };
    const ledger = seeded();
    const outcome = ledger.absorbRelatedRecordRefs({
      tool: partyTool,
      acceptedArgs: { bookingId: BOOKING_A },
      rows: [
        { guestMemberRef: MEMBER_M },
        { guestMemberRef: MEMBER_N },
        { guestMemberRef: MEMBER_M },
      ],
    });
    expect(outcome.absorbed).toBe(2);
    expect(ledger.size).toBe(3);
  });

  it("stops at the cap and says so, without evicting anything", () => {
    const ledger = createDiagnosticsConsentLedger({
      recordConsentGranted: true,
      peopleSearchGranted: false,
      selectedRecords: [{ kind: "booking", id: BOOKING_A }],
    });
    const rows = Array.from(
      { length: DIAGNOSTICS_CONSENT_LEDGER_MAX_ENTRIES + 3 },
      (_unused, index) => ({
        ownerMemberRef: `ckmember${String(index).padStart(16, "0")}`,
      }),
    );
    const outcome = ledger.absorbRelatedRecordRefs({
      tool: BLOCK_STATE,
      acceptedArgs: { bookingId: BOOKING_A },
      rows,
    });
    expect(outcome.capReached).toBe(true);
    expect(ledger.size).toBe(DIAGNOSTICS_CONSENT_LEDGER_MAX_ENTRIES);
    expect(ledger.has("booking", BOOKING_A)).toBe(true);
  });

  it("never invokes a getter on a projected row", () => {
    let invoked = 0;
    const row = {} as Record<string, unknown>;
    Object.defineProperty(row, "ownerMemberRef", {
      enumerable: true,
      get() {
        invoked += 1;
        return MEMBER_M;
      },
    });
    const ledger = seeded();
    ledger.absorbRelatedRecordRefs({
      tool: BLOCK_STATE,
      acceptedArgs: { bookingId: BOOKING_A },
      rows: [row as never],
    });
    expect(invoked).toBe(0);
    expect(ledger.has("member", MEMBER_M)).toBe(false);
  });
});

describe("consent ledger — contracts with the rest of the substrate (#2785)", () => {
  it("holds exactly the identifier shape the per-record entries accept", () => {
    // The ledger restates `RECORD_ID` rather than importing it (packs import from
    // tools, never the reverse). This is the reconciliation that keeps the two from
    // drifting: a value the argument schema accepts must be one the ledger can hold,
    // and one it refuses must be one the ledger refuses.
    const accepted = [BOOKING_A, MEMBER_M, PAYMENT_P, "a".repeat(20), "z".repeat(40)];
    for (const id of accepted) {
      expect(RECORD_ID.safeParse(id).success, id).toBe(true);
      const ledger = createDiagnosticsConsentLedger({
        recordConsentGranted: true,
        peopleSearchGranted: false,
        selectedRecords: [{ kind: "booking", id }],
      });
      expect(ledger.has("booking", id), id).toBe(true);
    }

    const refused = ["a".repeat(19), "a".repeat(41), "CKBOOKING0000000000000001", "ck-booking-0000000000001", "(unparseable)", ""];
    for (const id of refused) {
      expect(RECORD_ID.safeParse(id).success, id).toBe(false);
      const ledger = createDiagnosticsConsentLedger({
        recordConsentGranted: true,
        peopleSearchGranted: false,
        selectedRecords: [{ kind: "booking", id }],
      });
      expect(ledger.size, id).toBe(0);
    }
  });

  it("covers every consent record kind", () => {
    for (const kind of DIAGNOSTICS_CONSENT_RECORD_KINDS) {
      const ledger = createDiagnosticsConsentLedger({
        recordConsentGranted: true,
        peopleSearchGranted: false,
        selectedRecords: [{ kind, id: MEMBER_M }],
      });
      expect(ledger.has(kind, MEMBER_M), kind).toBe(true);
    }
  });

  it("says what this control actually does, in its own words", () => {
    // Not the page-context copy: that one promises field-level inclusion for one
    // record with an omission fallback, and this control has an investigation scope
    // and refuses rather than omitting. A label that disagrees with the server is
    // worse than no label.
    const record = DIAGNOSTICS_TOOL_CONSENT_COPY.record;
    expect(record.description).toContain("only for this question");
    expect(record.description).toContain("directly linked");
    expect(record.description).toContain("refused");
    expect(record.refusedNotice).toContain("Personal detail omitted");

    const search = DIAGNOSTICS_TOOL_CONSENT_COPY.search;
    expect(search.description).toContain("Off by default");
    expect(search.description).toContain("only for this question");
    for (const copy of [record.label, record.description, search.label, search.description]) {
      expect(copy.length).toBeGreaterThan(20);
    }
  });
});
