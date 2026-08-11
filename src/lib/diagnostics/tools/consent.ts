/**
 * AI Diagnostics — the INVESTIGATION CONSENT LEDGER (AID-7a, #2785; contract in
 * ADR-004 §1; owner decisions on #2378, 11 Aug 2026).
 *
 * ADR-004 §1 says a tool surfaces personal fields "only when the operator has
 * explicitly included that specific record". Until this module existed,
 * `surfacesPersonalData` was a declaration with no consumer: the flag recorded that
 * a row could identify a person and gated nothing at all, which the booking pack's
 * own docs disclosed in as many words. This is the gate.
 *
 * WHY IT IS A LEDGER AND NOT ONE RECORD. The obvious design — consent is one
 * `{kind, id}` pair, and an entry runs when its argument equals that id — cannot
 * drive the tool graph it has to drive. The flagship investigation ("why will this
 * booking not confirm?") crosses record kinds by the registry's OWN authored
 * guidance: `booking_block_state`'s scope text says, of the subscription blocker,
 * "its absence on a priced draft or a confirmed booking says nothing about the
 * owner's subscription; member_eligibility_state answers that". A booking-scoped
 * consent refuses that second call on both the kind and the argument. So consent is
 * granted over a bounded INVESTIGATION, which is exactly what epic #2369's owner
 * comment authorises: "for an explicit bounded investigation the agent may receive
 * the personal and financial information reasonably required… the restriction is
 * against unrestricted or bulk access, not against useful per-record evidence."
 *
 * THE FOUR RULES THAT KEEP "BOUNDED" TRUE:
 *
 *  1. SEEDED ONLY FROM WHAT THE OPERATOR PICKED. Entries with origin
 *     `operator_selected` come from the request's selected records, which the ask
 *     route must have re-resolved through the operator's own authority first (the
 *     owner's 3 Aug directive: client-provided record values are selectors only).
 *     This module cannot check that — it has no database — so it is stated as the
 *     caller's obligation on `createDiagnosticsConsentLedger` and asserted there.
 *  2. EXTENDED ONLY BY THE SERVER, FROM SERVER-OWNED PROJECTIONS. The only way to
 *     add an entry after seeding is `absorbRelatedRecordRefs`, which reads only the
 *     PROJECTED fields an entry DECLARES as related-record refs, only after a
 *     successful and audited call, and only for a call whose own record was already
 *     consented. Never from model text, never from free text, never from the client,
 *     never from a failed call. The projections are closed sets built by typed
 *     helpers, so a booking note an attacker wrote cannot become an id here.
 *  3. ONE HOP FROM THE OPERATOR'S OWN CHOICE. Absorption runs only when the calling
 *     entry's own record has origin `operator_selected`. A derived record can be
 *     READ (that is the point) but cannot be used to derive further, so the reachable
 *     set is the operator's selections plus their direct links — and not a walk of
 *     the club's membership graph one family link at a time. The plan did not state a
 *     depth bound; without one there is no bound at all.
 *  4. PER REQUEST, AND NEVER PERSISTED. The ledger is built for one request and
 *     discarded with it. Nothing here is written to a database, a cookie or a
 *     session, so "reset on a new submission / a changed record / a changed
 *     investigation" is not a rule someone has to remember to apply — it is the only
 *     behaviour available.
 *
 * THE MODEL CAN NEVER WRITE TO IT. There is no public method that takes an
 * arbitrary identifier. `absorbRelatedRecordRefs` is an instance method rather than
 * the free function the plan sketched precisely so the mutator can stay `#private`:
 * a free function would have needed a public `add`, and a public `add` is a seam a
 * later caller could reach with a value the model chose.
 *
 * PURE. No IO, no clock, no database. That is what lets `invoke.ts` hold one of
 * these without acquiring a dependency, and what lets the rules above be tested
 * exhaustively.
 */

import {
  DIAGNOSTICS_CONSENT_RECORD_KINDS,
  type DiagnosticsConsentRecordKind,
  type DiagnosticsRelatedRecordRef,
  type DiagnosticsToolRow,
} from "./types";

/**
 * The identifier shape the ledger will hold.
 *
 * It mirrors `RECORD_ID` in `packs/finance-shared.ts` — a 20-40 character lowercase
 * alphanumeric cuid, the shape every per-record entry's argument schema accepts —
 * and is RESTATED here rather than imported because `packs/` imports from `tools/`
 * and never the other way round. `consent.test.ts` reconciles the two against the
 * real schema, so a future widening on either side fails a test rather than drifting.
 *
 * Restating it is also what makes the ledger safe against the projection helpers'
 * own sentinels: `recordRefOrNull` returns the literal `(unparseable)` for a value
 * that is not id-shaped and the entries coalesce a missing ref to `""`. Neither can
 * match this pattern, so neither can enter the ledger as a record.
 */
const CONSENT_RECORD_ID = /^[a-z0-9]{20,40}$/;

/**
 * The most records one investigation's ledger may hold.
 *
 * A bound rather than a limit anybody is expected to hit: sixteen tool calls per
 * session, each of which may project up to its own row limit, is enough for a
 * pathological entry to grow this without one. It fails CLOSED — at the cap
 * absorption stops and reports that it stopped, and nothing is evicted, because
 * evicting an operator-selected record to make room for a derived one would revoke
 * consent the operator actually gave.
 */
export const DIAGNOSTICS_CONSENT_LEDGER_MAX_ENTRIES = 128;

/** How a record came to be in the ledger. */
export type DiagnosticsConsentEntryOrigin = "operator_selected" | "derived";

/** A record the ledger can hold, or be asked about. */
export interface DiagnosticsConsentRecordRef {
  kind: DiagnosticsConsentRecordKind;
  id: string;
}

/** One consented record, with its provenance. */
export interface DiagnosticsConsentEntry extends DiagnosticsConsentRecordRef {
  origin: DiagnosticsConsentEntryOrigin;
  /** The consented record this one was derived from; null when the operator picked it. */
  derivedFrom: DiagnosticsConsentRecordRef | null;
}

/**
 * What the ledger needs to know about the entry being invoked.
 *
 * A structural shape rather than `DiagnosticsToolEntry`, so this module does not
 * import `define.ts` (which declares these fields and would then import back for the
 * record-kind type — a cycle whose `defineDiagnosticsTool` is `undefined` at module
 * body time, which is the exact bug that split `define.ts` out of `registry.ts`).
 * A registry entry satisfies it structurally.
 */
export interface DiagnosticsConsentToolDeclaration {
  personalDataRecordKind?: DiagnosticsConsentRecordKind;
  personalDataRecordArgKey?: string;
  relatedRecordRefs?: readonly DiagnosticsRelatedRecordRef[];
}

export interface CreateDiagnosticsConsentLedgerInput {
  /**
   * The operator's per-request tick for reading the personal details of the records
   * they selected. Default OFF at every layer; this field is the server's record of
   * what the request actually carried.
   */
  recordConsentGranted: boolean;
  /**
   * The operator's per-request tick allowing the MODEL to run record search (owner
   * decision, #2378 Q2, 11 Aug 2026, overriding the operator-only recommendation).
   * Default OFF, covers this request only, never persisted.
   */
  peopleSearchGranted: boolean;
  /**
   * The records the operator selected for this investigation.
   *
   * THE CALLER MUST HAVE REVALIDATED THESE server-side, under this actor's own
   * freshly-read authority, before passing them: they arrive from a browser and are
   * selectors, not facts. An id this module cannot recognise as id-shaped is refused
   * rather than trusted, and counted in `rejectedSelectionCount` so the caller can
   * notice — but that check is a backstop for a malformed value, not a substitute
   * for the re-resolution.
   */
  selectedRecords: readonly DiagnosticsConsentRecordRef[];
}

/** What one absorption did. Returned so a caller can audit or assert on it. */
export interface DiagnosticsConsentAbsorption {
  /** Records newly added to the ledger. */
  absorbed: number;
  /** True when at least one candidate was dropped because the ledger is full. */
  capReached: boolean;
}

function ledgerKey(kind: DiagnosticsConsentRecordKind, id: string): string {
  return `${kind}:${id}`;
}

function isConsentRecordKind(
  value: unknown,
): value is DiagnosticsConsentRecordKind {
  return (
    typeof value === "string" &&
    (DIAGNOSTICS_CONSENT_RECORD_KINDS as readonly string[]).includes(value)
  );
}

function isConsentRecordId(value: unknown): value is string {
  return typeof value === "string" && CONSENT_RECORD_ID.test(value);
}

/**
 * The record ONE invocation is about, read from the arguments the entry's own schema
 * already accepted — or `null` when the entry declares no record, or the accepted
 * arguments do not carry a usable one.
 *
 * `null` is a REFUSAL for a personal-data entry, not a pass: `invoke.ts` treats "no
 * declared record" on an entry that surfaces personal data as consent refused, so a
 * declaration that goes missing closes the gate rather than opening it.
 */
export function consentedRecordForToolCall(
  tool: DiagnosticsConsentToolDeclaration,
  acceptedArgs: unknown,
): DiagnosticsConsentRecordRef | null {
  const kind = tool.personalDataRecordKind;
  const argKey = tool.personalDataRecordArgKey;
  if (kind === undefined || argKey === undefined) return null;
  if (typeof acceptedArgs !== "object" || acceptedArgs === null) return null;
  // A descriptor read, not a property read: `acceptedArgs` is the parsed argument
  // object, and a getter on it must never be invoked by the code deciding whether
  // this call is consented.
  const descriptor = Object.getOwnPropertyDescriptor(acceptedArgs, argKey);
  if (!descriptor || !("value" in descriptor)) return null;
  const id: unknown = descriptor.value;
  if (!isConsentRecordId(id)) return null;
  return { kind, id };
}

/**
 * One investigation's consent, held by the server for the life of one request.
 *
 * Its state is `#private` in the JavaScript sense, not merely `private` in the
 * TypeScript sense: the entries are unreachable from a caller that has the object,
 * so the only ways to change them are the two this class offers — seeding at
 * construction, and `absorbRelatedRecordRefs` under the rules in the module
 * docblock.
 */
export class DiagnosticsConsentLedger {
  /** The operator's per-request tick for personal details of selected records. */
  readonly recordConsentGranted: boolean;
  /** The operator's per-request tick allowing the model to run record search. */
  readonly peopleSearchGranted: boolean;
  /** Selections that were not id-shaped and were refused rather than seeded. */
  readonly rejectedSelectionCount: number;

  readonly #entries: Map<string, DiagnosticsConsentEntry>;

  constructor(input: CreateDiagnosticsConsentLedgerInput) {
    this.recordConsentGranted = input.recordConsentGranted === true;
    this.peopleSearchGranted = input.peopleSearchGranted === true;
    this.#entries = new Map();

    let rejected = 0;
    for (const selection of input.selectedRecords) {
      if (
        !isConsentRecordKind(selection?.kind) ||
        !isConsentRecordId(selection?.id)
      ) {
        rejected += 1;
        continue;
      }
      if (this.#entries.size >= DIAGNOSTICS_CONSENT_LEDGER_MAX_ENTRIES) {
        rejected += 1;
        continue;
      }
      const key = ledgerKey(selection.kind, selection.id);
      if (this.#entries.has(key)) continue;
      this.#entries.set(key, {
        kind: selection.kind,
        id: selection.id,
        origin: "operator_selected",
        derivedFrom: null,
      });
    }
    this.rejectedSelectionCount = rejected;
  }

  /** How many records this investigation covers. */
  get size(): number {
    return this.#entries.size;
  }

  /** True when this exact record is covered by this investigation's consent. */
  has(kind: DiagnosticsConsentRecordKind, id: string): boolean {
    return this.#entries.has(ledgerKey(kind, id));
  }

  /** How this record came to be covered, or `null` when it is not covered. */
  originOf(
    kind: DiagnosticsConsentRecordKind,
    id: string,
  ): DiagnosticsConsentEntryOrigin | null {
    return this.#entries.get(ledgerKey(kind, id))?.origin ?? null;
  }

  /** A copy of the ledger, for assertions and operator-facing summaries. */
  entries(): DiagnosticsConsentEntry[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }

  /**
   * Extend the investigation with the records THIS ENTRY DECLARED it projects, from
   * the rows it actually returned.
   *
   * Every guard below is load-bearing, and each one is a way this could have become
   * an id oracle:
   *
   *  - the entry must DECLARE the field, so a projection that happens to contain an
   *    identifier does not silently widen consent;
   *  - the calling entry's own record must be in the ledger with origin
   *    `operator_selected` (rule 3 — one hop);
   *  - the value must be a string of exactly the id shape, which excludes both
   *    projection sentinels (`(unparseable)` and `""`);
   *  - the rows are the PROJECTED rows, so the value has already been through the
   *    entry's fixed column allowlist, redaction and per-field cap.
   *
   * The caller must only call it after a SUCCESSFUL, AUTHORISED, AUDITED invocation —
   * `invoke.ts` is the only caller and does exactly that.
   */
  absorbRelatedRecordRefs(input: {
    tool: DiagnosticsConsentToolDeclaration;
    acceptedArgs: unknown;
    rows: readonly DiagnosticsToolRow[];
  }): DiagnosticsConsentAbsorption {
    const declared = input.tool.relatedRecordRefs ?? [];
    if (declared.length === 0) return { absorbed: 0, capReached: false };

    const source = consentedRecordForToolCall(input.tool, input.acceptedArgs);
    if (!source) return { absorbed: 0, capReached: false };
    if (this.originOf(source.kind, source.id) !== "operator_selected") {
      return { absorbed: 0, capReached: false };
    }

    let absorbed = 0;
    let capReached = false;
    for (const row of input.rows) {
      for (const ref of declared) {
        if (!isConsentRecordKind(ref.kind)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(row, ref.field);
        if (!descriptor || !("value" in descriptor)) continue;
        const id: unknown = descriptor.value;
        if (!isConsentRecordId(id)) continue;
        const key = ledgerKey(ref.kind, id);
        if (this.#entries.has(key)) continue;
        if (this.#entries.size >= DIAGNOSTICS_CONSENT_LEDGER_MAX_ENTRIES) {
          capReached = true;
          continue;
        }
        this.#entries.set(key, {
          kind: ref.kind,
          id,
          origin: "derived",
          derivedFrom: { kind: source.kind, id: source.id },
        });
        absorbed += 1;
      }
    }
    return { absorbed, capReached };
  }
}

/**
 * Build one investigation's ledger. See
 * `CreateDiagnosticsConsentLedgerInput.selectedRecords` for the caller's
 * revalidation obligation.
 */
export function createDiagnosticsConsentLedger(
  input: CreateDiagnosticsConsentLedgerInput,
): DiagnosticsConsentLedger {
  return new DiagnosticsConsentLedger(input);
}

/**
 * A ledger that consents to nothing — the fail-closed default for any caller that
 * has no operator decision to represent (a background path, a test, a route that
 * has not built one yet).
 *
 * A FACTORY AND NOT A SHARED CONSTANT, deliberately. A module-level singleton would
 * be one object every request holds a reference to, and `absorbRelatedRecordRefs`
 * mutates the object it is called on — so one shared instance would let consent leak
 * between requests, which is the single worst failure this module could have.
 */
export function createEmptyDiagnosticsConsentLedger(): DiagnosticsConsentLedger {
  return new DiagnosticsConsentLedger({
    recordConsentGranted: false,
    peopleSearchGranted: false,
    selectedRecords: [],
  });
}

/**
 * Operator-facing copy for the TOOL-CHANNEL consent controls (ADR-004 §1).
 *
 * IT IS NOT `DIAGNOSTICS_SENSITIVE_INCLUSION_COPY`, and reusing that one would have
 * been the mistake its own docblock warns about — "a checkbox whose label disagrees
 * with the server's behaviour is worse than no checkbox". The page-context copy
 * promises field-level inclusion for "the specific record you are looking at — and
 * only that record", with an omission fallback. This control has different
 * semantics on both counts: its scope is the investigation (the records selected AND
 * the records directly linked to them), and its failure mode is a refusal that is
 * reported as a refusal, not a quietly omitted field. So the words say that.
 *
 * The page-context copy stays exactly where it is, for the page-context channel.
 */
export const DIAGNOSTICS_TOOL_CONSENT_COPY = {
  /** The personal-details tick. */
  record: {
    label: "Include the personal details of the records I selected",
    description:
      "Off by default, and only for this question. When you tick this, the assistant may read the personal details of the records you selected — and of records directly linked to them, such as the member who owns a booking you picked. Without it those reads are refused, and the answer says so rather than guessing.",
    /** What the operator is told when a read was refused for want of this tick. */
    refusedNotice:
      "Personal detail omitted. To see it, select the record it belongs to and tick “Include the personal details of the records I selected”.",
  },
  /** The people-search tick (owner decision, #2378 Q2, 11 Aug 2026). */
  search: {
    label: "Let the assistant search for people and records",
    description:
      "Off by default, and only for this question. Leave it off and you choose every record yourself; the assistant can then only read the ones you picked and what is directly linked to them. Tick it and the assistant may also run searches that return lists of members, bookings and payments.",
    /** What the operator is told when a search was refused for want of this tick. */
    refusedNotice:
      "The assistant tried to search for records and was refused, because searching was not allowed for this question.",
  },
} as const;
