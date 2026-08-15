/**
 * AI Diagnostics — SELECT-only tool substrate: shared types and bounds (AID-5,
 * epic #2369, issue #2374).
 *
 * THE ONE INVARIANT THAT MATTERS: the model never supplies SQL. A tool is a
 * server-owned pairing of a fixed SQL text, a fixed projection, a fixed row/byte
 * ceiling, and a fixed admin-permission requirement. The model may only choose
 * WHICH registered tool to call and supply arguments that a `.strict()` Zod
 * schema has already accepted; those arguments become positional query
 * parameters and nothing else. There is no string interpolation into SQL
 * anywhere in this substrate, and no code path that accepts SQL from a caller.
 *
 * SECURITY POSTURE (do not weaken without an owner decision on #2370):
 *  - ADR-001: read-only. No mutation tool, no model SQL, no raw credentials, no
 *    raw provider payloads. The only writes this substrate performs are its own
 *    approved-metadata audit rows, on the APPLICATION connection — never the
 *    SELECT-only one.
 *  - ADR-002: every invocation re-reads the caller's permission matrix FRESH
 *    from the database-joined access roles and requires `view` on EVERY area the
 *    tool declares (AND, never OR). Withholding a tool definition from the model
 *    is a courtesy; the server-side check is the control, and it runs on every
 *    invocation whether the definition was offered or not.
 *  - ADR-003: a tool result is UNTRUSTED, prompt-injection-capable evidence with
 *    an observed-at instant. It carries no system authority.
 *  - ADR-004: an audit row carries tool id, auth outcome, row/byte/timing counts
 *    and non-reversible hashes — never raw arguments, never raw results.
 *  - ADR-007: the queries run as a dedicated non-superuser SELECT-only role
 *    (`AI_DIAGNOSTICS_DATABASE_URL`), inside a READ ONLY transaction, under a
 *    statement timeout, with a SQL-level row cap the executor imposes itself.
 *
 * FAIL CLOSED EVERYWHERE. Unknown tool, malformed arguments, exhausted round
 * budget, unhealthy metering, denied authorization, missing or mis-privileged
 * database role, timeout, oversized result, failed redaction, failed audit write
 * — every one of them returns a result carrying NO rows.
 */

import type { AdminPermissionArea } from "@/lib/admin-permissions";

/**
 * Result/registry format version. A consumer pins the exact value so it can
 * never silently read a shape it does not understand (same discipline as the
 * knowledge bundle in AID-3 and the page context in AID-4).
 */
export const DIAGNOSTICS_TOOL_SCHEMA_VERSION = 1 as const;

/**
 * THE SERVER-OWNED BOUND LADDER, IN ONE PLACE AND DERIVED (#2804).
 *
 * Four bounds govern one `server_owned` read, and the relation between them is
 * worth stating carefully, because the obvious shorthand is WRONG (#2804 review).
 * The wait is not "smaller than" the transaction timeout — it comes BEFORE it, and
 * the two ADD:
 *
 *   statement < transaction      and      (wait + transaction) < graph < outer race
 *
 * "wait < read < graph < outer race" was true while the wait was 2 000 and became
 * false the moment it became 20 000 — a fair illustration of why the numbers below
 * are derived rather than merely described.
 *
 * Break the relation and the operator gets a vague answer instead of a specific one:
 * a graph deadline clearing only the transaction would kill a read for the time it
 * spent queuing for a connection it then went on to get, and call it "took too
 * long". #2786 found the failure mode that makes this worth deriving rather
 * than listing: two unlinked names for one bound, where narrowing one silently
 * left the other behind and every test still passed. So the three upper bounds
 * are COMPUTED from the two real choices below. There is no second literal to
 * keep in step, and no way to move one without moving what depends on it.
 *
 * OWNER DECISION 12 Aug 2026 (#2804): a diagnostics read should WAIT for a busy
 * database rather than give up. The wait went from 2 s to 8 s, which moves the
 * worst case before a refusal from 9 s to 15 s.
 *
 * IT IS 8 AND NOT THE 20 FIRST CHOSEN, and the reason is the rung below: pg's own
 * pool ceiling is 10 000 in production, so a longer wait is simply not reachable
 * without raising a limit that member traffic shares. That was put back to the owner
 * with the measurement, and 8 s inside the existing ceiling was chosen over changing
 * the whole application's pool behaviour for an admin tool.
 *
 * The owner's condition stands: the UI shows a "still working" state (#2378). A
 * 15-second wait with no feedback is worse than a fast refusal, because an admin
 * reloads, and a reload during contention adds another queued reader.
 *
 * THE STATEMENT TIMEOUT DELIBERATELY DID NOT MOVE. Waiting longer to START is
 * what was asked for. Letting an already-running query run longer is a different
 * thing, and it is the half that actually loads the database.
 */
const READ_ONLY_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * The owner's decision, and the only reason this ladder changed (#2804).
 *
 * IT IS BOUNDED BY SOMETHING THIS LADDER DOES NOT OWN, which is the whole story of
 * how the first attempt got it wrong. pg's `connectionTimeoutMillis` — set from
 * `pool_timeout` in `DATABASE_URL`, 10 000 in production — covers time spent QUEUED
 * as well as time spent connecting. Ask Prisma to wait longer than that and pg
 * rejects first, with a bare `Error` carrying no code: the longer wait never
 * happens, the refusal cannot be classified, and every unit test still passes
 * because they hand-build the error. A first draft of #2804 set this to 20 000
 * against a 10 000 pool ceiling and claimed a 27-second worst case the code could
 * not reach.
 *
 * So it sits deliberately BELOW the pool's own ceiling, which is what makes
 * Prisma's own `maxWait` the thing that fires and `P2028` the error that arrives.
 * `__tests__/pool-acquisition-ladder.test.ts` asserts that against the real
 * production connection strings, so raising this without raising the pool — a
 * whole-application decision, since that pool serves member traffic too — fails.
 */
const READ_ONLY_MAX_WAIT_MS = 8_000;

/**
 * How much longer the whole transaction may run than any one statement in it.
 * A margin over one statement, not a bound in its own right — which is why it is
 * small, and why it is expressed as a margin.
 */
const READ_ONLY_TRANSACTION_MARGIN_MS = 2_000;

/**
 * Room for the JavaScript either side of the database work — assembling the
 * evidence rows, the collaborators' own pure computation — on top of the worst
 * case the database itself can impose.
 */
const SERVER_EVIDENCE_MARGIN_MS = 5_000;

/**
 * The executor's own margin above one source's deadline. It exists so the
 * SOURCE's specific refusal wins the race: the outer bound is the backstop for a
 * calculation that hangs on something with no deadline at all, never the thing
 * that normally fires.
 */
const SERVER_EVIDENCE_EXECUTOR_MARGIN_MS = 5_000;

/**
 * Every ceiling the substrate enforces. They are deliberately small: a
 * diagnostics tool exists to answer "what does the deployed system currently say
 * about X", not to move data. A tool that wants more than this is a report, and
 * a report belongs in the admin UI where it is already governed.
 *
 * `maxRows`/`maxResultBytes` are HARD CEILINGS on top of each tool's own
 * declared limit — a registry entry may be stricter, never looser, and
 * `registry.ts`'s contract test refuses a looser one.
 */
export const DIAGNOSTICS_TOOL_BOUNDS = {
  /** Registry key, e.g. `diagnostics.substrate_probe`. */
  toolIdMaxChars: 64,
  /** Hard ceiling on rows any tool may return, imposed in SQL by the executor. */
  maxRows: 200,
  /** Hard ceiling on the UTF-8 byte length of one tool's projected result. */
  maxResultBytes: 32_768,
  /** Cap on any single free-text value inside a projected row, after redaction. */
  fieldValueMaxChars: 200,
  /** Cap on the number of projected columns one row may carry. */
  maxFieldsPerRow: 24,
  /** `statement_timeout` for the tool's read-only transaction. */
  statementTimeoutMs: READ_ONLY_STATEMENT_TIMEOUT_MS,
  /**
   * How long a `server_owned` read waits for a connection from the application
   * pool before refusing (Prisma's `maxWait`). Raised from 2 s by owner decision
   * #2804: an admin would rather wait for a busy database than be told to try
   * again.
   *
   * It is finite because it must be — but be precise about what it costs (#2804
   * review). A WAITING read holds no pool connection; that is what waiting means.
   * What grows is QUEUE DEPTH, not occupancy, and occupancy stays bounded by the
   * unchanged 7 s transaction timeout. An unbounded wait would still be wrong — a
   * queue nobody ever leaves is its own failure — but it is not the "every reader
   * pins a connection" story that is easy to tell and wrong.
   */
  readOnlyMaxWaitMs: READ_ONLY_MAX_WAIT_MS,
  /**
   * The interactive-transaction ceiling: strictly ABOVE the statement timeout so
   * the database's own cancellation is what a slow read hits and the operator
   * gets `57014 query_canceled` rather than a generic Prisma transaction error.
   */
  readOnlyTransactionTimeoutMs:
    READ_ONLY_STATEMENT_TIMEOUT_MS + READ_ONLY_TRANSACTION_MARGIN_MS,
  /**
   * Deadline on ONE `server_owned` evidence graph — the JavaScript race each
   * source runs. Derived to sit above the worst case the database can impose
   * (the full wait for a connection PLUS the full transaction), so a source
   * never reports "took too long" for time it spent queuing for a connection
   * that it would have got.
   */
  serverEvidenceDeadlineMs:
    READ_ONLY_MAX_WAIT_MS +
    READ_ONLY_STATEMENT_TIMEOUT_MS +
    READ_ONLY_TRANSACTION_MARGIN_MS +
    SERVER_EVIDENCE_MARGIN_MS,
  /** `lock_timeout` — a diagnostics read must never queue behind a writer. */
  lockTimeoutMs: 2_000,
  /** `idle_in_transaction_session_timeout` — a wedged read frees its backend. */
  idleInTransactionTimeoutMs: 10_000,
  /** Tool calls allowed inside ONE provider round. */
  maxToolCallsPerRound: 4,
  /** Tool calls allowed across a whole diagnostics session. */
  maxToolCallsPerSession: 16,
  /** Connections the dedicated SELECT-only pool may open. */
  maxPoolConnections: 3,
  /**
   * CLIENT-side deadline on any single query the diagnostics pool sends (pg's
   * `query_timeout`), deliberately LONGER than `statementTimeoutMs`.
   *
   * The layering is the point, and the order matters. `statement_timeout` is the
   * SERVER cancelling and replying, which is the control that produces SQLSTATE
   * 57014 and the honest "that read took too long" answer — so it must win. This
   * one only fires when no reply can travel back at all (a black-holed route, a
   * wedged pooler holding the socket open), which pg otherwise leaves unbounded:
   * `connectionTimeoutMillis` covers acquiring a client, never the round trip.
   */
  queryTimeoutMs: 10_000,
  /**
   * How long the SERVER's verdict on the diagnostics role stays good for. The
   * probe is one round trip; caching it for the life of the process meant a role
   * escalated by hand was reported `verified` until the container restarted.
   */
  rolePrivilegeTtlMs: 60_000,
  /**
   * Hard deadline on that probe, above `queryTimeoutMs` for the same
   * server-control-wins reason: an unanswered probe must become the `unverified`
   * refusal this substrate promises, never a readiness request that hangs.
   */
  privilegeProbeTimeoutMs: 12_000,
  /**
   * Deadline on ONE `server_owned` evidence read (AID-6A, #2375) — the fixed
   * first-party calculations a tool may read instead of the SELECT-only database
   * (readiness, budget/usage, cron health, deployed-bundle identity).
   *
   * Above `privilegeProbeTimeoutMs` on purpose. The canonical readiness answer
   * INCLUDES the role-privilege probe, so a deadline at or below the probe's own
   * would turn "the role could not be reached, and readiness says so" — the exact
   * answer an operator needs — into a timeout that says nothing. This bound is the
   * backstop for a calculation that hangs on something with no deadline of its own,
   * and it fails closed: an expired read returns `evidence_unavailable` and no rows.
   *
   * DERIVED from `serverEvidenceDeadlineMs` since #2804, not chosen. It is the
   * OUTER race, so it has to stay above the source's own deadline or it fires
   * first and replaces a specific refusal with a generic one. When the wait for a
   * connection moved, this had to move with it; a hand-set 15 000 would sit at or
   * below the source deadline and invert the ladder, and every existing test would
   * still have passed. That is exactly the shape #2786 was filed about.
   */
  serverEvidenceTimeoutMs:
    READ_ONLY_MAX_WAIT_MS +
    READ_ONLY_STATEMENT_TIMEOUT_MS +
    READ_ONLY_TRANSACTION_MARGIN_MS +
    SERVER_EVIDENCE_MARGIN_MS +
    SERVER_EVIDENCE_EXECUTOR_MARGIN_MS,
  /** Hard cap on the rendered evidence block handed to the model. */
  renderedBlockMaxChars: 8_000,
} as const;

/**
 * A registered tool id. Lowercase dotted segments only — a closed server-side
 * table key, never a pathname or anything else with prefix semantics.
 */
export const DIAGNOSTICS_TOOL_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Why an invocation produced no rows. Every value is a stable machine code; the
 * operator-facing sentence travels beside it so neither the UI nor the model has
 * to invent one.
 *
 * `unknown_tool` and `permission_denied` are deliberately DISTINCT even though
 * both deny: conflating them would make a misconfigured registry and an
 * authorization anomaly the same audit row.
 */
export type DiagnosticsToolFailureReason =
  /** No such registry key. */
  | "unknown_tool"
  /** Arguments failed the tool's `.strict()` schema. Details are never echoed. */
  | "invalid_args"
  /** The session's per-round or per-session tool-call budget is spent. */
  | "call_budget_exhausted"
  /** Diagnostics usage can no longer be metered (AID-2 circuit breaker). */
  | "metering_unavailable"
  /** The acting member row does not exist (a stale or forged acting member id). */
  | "actor_unresolved"
  /**
   * The acting member exists but their account is locked out of the admin surface
   * — deactivated, or under a forced password change. Distinct from
   * `actor_read_failed` because an administratively locked-out admin is not a
   * database fault, and distinct from `permission_denied` because it is not a
   * per-area outcome: there is no authorized actor here at all. AID-4's page
   * context reports the same cause as `actor_blocked`, and the two evidence
   * channels must not disagree about what happened.
   */
  | "actor_blocked"
  /** The fresh role read itself failed — kept distinct from `actor_unresolved`. */
  | "actor_read_failed"
  /** The caller lacks `view` on at least one area the tool declares. */
  | "permission_denied"
  /**
   * The entry surfaces personal data (`surfacesPersonalData: true`) and the record
   * it was asked about is not one the operator consented to for this investigation
   * (AID-7a, #2785; ADR-004 §1).
   *
   * DISTINCT FROM `permission_denied`, and the distinction is the whole point: the
   * caller may well hold every area the entry declares. What is missing is the
   * operator's own per-request inclusion of THAT record, which ADR-004 §1 requires
   * on top of the permission check. Reporting it as a permission denial would send
   * an operator to a Full Admin to be granted access they already have.
   *
   * It is ADR-004 §1's SECOND branch — "an explicit 'personal detail omitted —
   * include the record to see it'" — taken at the whole-result level rather than
   * field by field, because a second per-entry projection is out of scope for this
   * substrate (recorded as an ADR-004 implementation note).
   */
  | "sensitive_consent_required"
  /**
   * The entry reads ONE NAMED RECORD but surfaces no personal fields, and the record
   * it was asked about is not one this investigation covers (#2785 review).
   *
   * A SECOND REASON RATHER THAN A WIDER FIRST ONE. `booking_audit_history`,
   * `payment_refund_state`, `xero_invoice_linkage` and the two audit-history entries
   * return stable codes, amounts and instants — no names — so telling their operator
   * "that diagnostics tool reads personal details" would be false, and a durable row
   * counted as a personal-inclusion refusal would overstate what was refused. What
   * they DO have in common with the personal-data entries is the bound ADR-004 §1
   * puts on the investigation: evidence about one identified subject flows only for
   * subjects the operator put in scope. The remedy is the same (select the record),
   * the sentence is honest, and an auditor can still count the two apart.
   *
   * It also carries the entries whose record KIND an argument chooses and whose
   * chosen subject is not a kind the ledger can hold at all — a manual refund task,
   * a partner link, a Xero-linked credit note. Those refuse here rather than running
   * unbounded.
   */
  | "record_not_included"
  /**
   * The entry is declared `operatorOnly` — record SEARCH, which returns a bounded
   * list of people or bookings — and this invocation is not one the operator
   * authorised for the model (AID-7a, #2785).
   *
   * Two invocations are allowed and everything else refuses here: an
   * `invocationChannel: "operator_action"` call (which would render to the operator's
   * browser and send nothing to the provider), and a model tool call on a request
   * where the operator ticked the per-request people-search box (owner decision,
   * #2378, 11 Aug 2026). The tick is per request, defaults off and is never
   * persisted, so an otherwise identical later request refuses again.
   *
   * The `operator_action` channel is TEST-ONLY today (AID-8 F5): no production caller
   * passes it, so in practice this state is reached whenever the model asks for a
   * search the operator did not tick.
   */
  | "operator_action_required"
  /** `AI_DIAGNOSTICS_DATABASE_URL` is absent, malformed, or reuses the app role. */
  | "database_not_configured"
  /** The connected role is NOT the least-privilege shape ADR-007 requires. */
  | "database_role_unsafe"
  /** The role is otherwise safe but lacks one or more declared SELECT grants. */
  | "database_grants_missing"
  /** The read failed, or the statement timeout cancelled it. */
  | "query_failed"
  /**
   * A `server_owned` evidence source (AID-6A, #2375) refused or did not answer
   * inside `serverEvidenceTimeoutMs`. Deliberately DISTINCT from `query_failed`:
   * that one means the SELECT-only database read failed, and an operator's next
   * step for it (check the diagnostics role, ask a narrower question) is not the
   * next step here (the first-party calculation this tool reads is unavailable —
   * usually because the application's own database is unreachable). Conflating
   * them would send an operator to the wrong credential.
   */
  | "evidence_unavailable"
  /**
   * The read never STARTED: it waited the full `readOnlyMaxWaitMs` for a
   * connection from the application pool and did not get one (#2804).
   *
   * Distinct from `evidence_unavailable` because the operator's next step is
   * different, and because the two are easy to confuse into one useless message.
   * `evidence_unavailable` means the calculation ran and could not answer —
   * usually the application database is unreachable, and the next step is to
   * check that. This one means the database is REACHABLE and BUSY: nothing is
   * broken, the read queued for the full wait and gave up, and the next step is
   * to try again shortly or find what is holding connections. Telling an admin
   * "evidence could not be gathered" when the true answer is "everything is fine,
   * it is just busy" sends them to look for a fault that does not exist.
   *
   * It exists at all because #2804 made the wait long. At two seconds a busy
   * refusal was rare enough to leave folded in; at eight seconds, an admin who
   * waited that long is owed an accurate reason for it.
   */
  | "evidence_database_busy"
  /** The projected result exceeded the tool's byte ceiling. Never truncated. */
  | "result_too_large"
  /** A projection or redaction step threw. Evidence is discarded, not partial. */
  | "redaction_failed"
  /** The approved-metadata audit row could not be written. Rows are discarded. */
  | "audit_unavailable"
  /**
   * A collaborator threw where its contract says it returns a typed refusal.
   * That is a bug, and the executor still has to fail closed rather than let the
   * exception escape and lose the audit trail — so it is a reason of its own
   * rather than being disguised as one of the specific ones above.
   */
  | "internal_error";

/**
 * What an audit row records in place of `argsHash` when the ACCEPTED arguments
 * are LOW-ENTROPY enough that an unkeyed digest of them would be REVERSIBLE.
 *
 * ADR-004 §4 permits "a stable, NON-REVERSIBLE hash of a query key" and forbids
 * recording "raw tool arguments" or "unrestricted personal identifiers (a
 * member's name, email …)". An unkeyed SHA-256 over a three-character surname
 * prefix, a six-to-fifteen digit phone number or a guessable email address is not
 * non-reversible in any useful sense: the candidate space is small enough that a
 * reader of the audit metadata can enumerate it offline and match the digest, so
 * the hash IS the argument with extra steps.
 *
 * It is a distinct value rather than `null` because the two facts differ and a
 * reader of a durable row must be able to tell them apart: `null` means the
 * arguments never parsed (there is no canonical form of input we refused), and
 * this sentinel means the arguments parsed, ran, and were deliberately not
 * digested. Neither is ever a 64-character hex digest, so a consumer can classify
 * the field on shape alone.
 */
export const DIAGNOSTICS_ARGS_HASH_REDACTED = "low_entropy_args_redacted";

/**
 * WHERE AN INVOCATION CAME FROM — a server-owned, closed discriminant (AID-7a,
 * #2785).
 *
 * It is NOT `surface`. That field is free-form, defaulted by the executor and
 * consumed only inside the audit row's description sentence; a gate cannot be built
 * on a string any caller may invent. This one is a required field on every
 * invocation with no default, so a new call site has to state which of the two
 * things it is, and a reviewer sees it in the diff:
 *
 *  - `operator_action` — the operator themselves, through a server route that
 *    renders the result to their own browser and sends nothing to the model
 *    provider. RESERVED AND TEST-ONLY TODAY (AID-8 F5): the record picker this
 *    describes is not built, and no production code path passes this value — the
 *    only invoker, `answer/loop.ts`, always passes `model_tool_use`. The channel
 *    and its gate-4a bypass exist and are exercised by tests, so when an
 *    operator-action invoker is finally wired its authorization and consent must be
 *    re-verified on that path rather than assumed from these tests.
 *  - `model_tool_use` — the bounded provider loop, executing a `tool_use` block the
 *    MODEL chose. Everything an attacker can write into evidence text reaches tool
 *    arguments through this channel, so it is the one the gates are written for.
 */
export type DiagnosticsInvocationChannel = "operator_action" | "model_tool_use";

/**
 * The record kinds a consent decision can be about (AID-7a, #2785; ADR-004 §1).
 *
 * Closed, and matching the argument shapes the packs already take: every entry that
 * surfaces personal data names its record with a `bookingId`, a `memberId` or a
 * `paymentId`. A kind that is not on this list cannot be consented to, which is the
 * fail-closed default a future pack should have to argue against.
 */
export const DIAGNOSTICS_CONSENT_RECORD_KINDS = [
  "booking",
  "member",
  "payment",
] as const;

export type DiagnosticsConsentRecordKind =
  (typeof DIAGNOSTICS_CONSENT_RECORD_KINDS)[number];

/**
 * A PROJECTED field that names a directly linked record, declared by the entry that
 * projects it (AID-7a, #2785).
 *
 * The point of declaring it on the entry rather than deriving it from a field name
 * is that the derivation would be a guess about server data. This is a statement by
 * the tool author, reviewed with the entry, that this exact projected column carries
 * the identifier of a record of this exact kind — which is what makes it safe for
 * the consent ledger to follow.
 */
export interface DiagnosticsRelatedRecordRef {
  /** The key in the entry's own PROJECTED row. Never a raw column name. */
  field: string;
  kind: DiagnosticsConsentRecordKind;
}

/** A projected scalar. Deliberately not `unknown`: a tool returns flat scalars. */
export type DiagnosticsToolFieldValue = string | number | boolean | null;

/** One projected row: an allowlisted, redacted, bounded set of flat scalars. */
export type DiagnosticsToolRow = Record<string, DiagnosticsToolFieldValue>;

/**
 * The APPROVED audit metadata for one invocation (ADR-004 §4). Deliberately a
 * separate object from the evidence so a caller that persists an audit row
 * cannot accidentally persist a row value: nothing here is, or is derived from,
 * a column's contents except through a non-reversible hash.
 */
export interface DiagnosticsToolAudit {
  toolId: string;
  /** The areas the tool declares, recorded even when the check denied. */
  areasChecked: AdminPermissionArea[];
  authOutcome: "allowed" | "denied";
  /**
   * Whether this invocation was the OPERATOR'S own action or a model tool call
   * (AID-7a, #2785). Recorded because "an admin ran a search themselves" and "the
   * model ran a search" are different events, and before this the durable row could
   * not tell them apart at all.
   */
  invocationChannel: DiagnosticsInvocationChannel;
  /**
   * The ADR-004 §1 PERSONAL-DATA inclusion decision for this invocation. It records
   * the DECISION, not whether data ultimately flowed: a consented read that then
   * failed at the database is `granted`, because the operator's consent did cover it.
   *
   *  - `not_applicable` — the identified entry does not surface personal data. A
   *    per-record entry that was refused because the investigation does not cover its
   *    record (`record_not_included`) is still `not_applicable`: no personal
   *    inclusion decision was needed, and `failureReason` is what says it was refused;
   *  - `not_reached` — the invocation was refused before the consent gates ran, or no
   *    entry was identified at all (so whether it is sensitive is unknown);
   *  - `granted` — the inclusion was authorised. For a per-record entry that means
   *    the operator ticked personal details AND this investigation covers the record;
   *    for a SEARCH it means the operator ticked people-search, or ran the search
   *    themselves via an `invocationChannel: "operator_action"` call (a test-only
   *    channel today — AID-8 F5 — with no production caller), which is their own
   *    inclusion act and is why such a row can honestly read `granted` beside
   *    `peopleSearchTick: "withheld"`;
   *  - `refused` — the inclusion was not authorised and the invocation was refused
   *    for that reason: `sensitive_consent_required` for a per-record entry,
   *    `operator_action_required` for a search the operator did not allow the model
   *    to run. Both are ADR-004 §1 refusals of personal data; `failureReason`
   *    separates them, and an auditor counting §1 refusals wants both.
   *
   * Four values rather than three on purpose: collapsing `not_reached` into
   * `not_applicable` would put "this entry is not sensitive" on a row where nobody
   * had established that.
   */
  sensitiveInclusion:
    | "not_applicable"
    | "not_reached"
    | "granted"
    | "refused";
  /**
   * The KIND of record THIS INVOCATION was about, or null when the entry names none.
   *
   * Resolved per invocation rather than copied from the entry, because three entries
   * choose their subject with an argument (`{subject, recordId}`,
   * `{localModel, localId}`): for those the kind is not a property of the entry at
   * all, and a row that recorded one would be recording the wrong one.
   *
   * It is therefore `null` in three cases, and they are all the same fact — nobody
   * established a kind: the entry names no record; the invocation was refused before
   * the consent gate ran, so its arguments were never resolved (`sensitiveInclusion`
   * reads `not_reached` beside it); or the arguments named a subject no consent kind
   * covers. Reading the entry's static declaration onto a row whose arguments never
   * parsed would assert a subject that was never identified.
   */
  consentRecordKind: DiagnosticsConsentRecordKind | null;
  /**
   * How the record this invocation was about came to be in the investigation — the
   * operator picked it, or the server derived it from a declared projected field of
   * an earlier consented call. Null when this investigation does not cover that
   * record at all, and null when no record was resolved or the gate never ran.
   *
   * IT IS RECORDED ON A REFUSAL TOO (#2785 review), and that is what makes the three
   * causes of a consent refusal separable in the durable log. Read with
   * `consentRecordKind` and `recordConsentTick`:
   *
   *  - kind `null` — the arguments named no record the ledger can hold, so nothing
   *    was resolved to check;
   *  - a kind with origin `null` — a real record this investigation does NOT cover.
   *    On a `model_tool_use` row this is the pivot the ledger exists to catch: the
   *    model asked about a record the operator never included;
   *  - a kind with a real origin, beside `recordConsentTick: "withheld"` — a record
   *    the operator DID include, refused only for the unticked personal-details box.
   *
   * Before this the first two and the third were one row, so "the model tried to
   * reach outside the investigation" and "the operator forgot to tick a box" were
   * indistinguishable to anyone reading the trail afterwards.
   *
   * NO SUBJECT RECORD ID, deliberately and in line with this type's own contract:
   * `argsHash` already pins WHICH record non-reversibly, and kind + origin +
   * `argsHash` together are the forensic record that a deliberate act occurred
   * without adding an identifier to a durable row.
   */
  consentRecordOrigin: "operator_selected" | "derived" | null;
  /**
   * The per-request personal-details tick as it stood for this invocation (ADR-004
   * §1). Recorded on EVERY row for the same reason `peopleSearchTick` is: it is
   * request-level state, and answering "was the assistant allowed to read personal
   * details during this question" from the rows that happen to be personal-data reads
   * would answer it only where the permission was used.
   *
   * It is the tick, NOT the outcome. `sensitiveInclusion` is the decision this
   * invocation reached; this field is the state of the operator's box, which is what
   * separates a refusal caused by the box from a refusal caused by the record.
   */
  recordConsentTick: "granted" | "withheld";
  /**
   * The per-request people-search tick as it stood for this invocation (owner
   * decision, #2378 Q2, 11 Aug 2026). Recorded on EVERY row, not only on search
   * ones: "was the model allowed to look people up during this session" is a
   * question about the request, and answering it from the rows that happen to be
   * searches would answer it only when the capability was used.
   */
  peopleSearchTick: "granted" | "withheld";
  /** Set on every non-success exit; null on success. */
  failureReason: DiagnosticsToolFailureReason | null;
  /**
   * sha256 of the canonical JSON of the ACCEPTED arguments — never the arguments
   * themselves. Null when the arguments never parsed (there is no canonical form
   * of input we refused to understand, and hashing the raw input would put
   * operator-supplied text into a durable row).
   *
   * `DIAGNOSTICS_ARGS_HASH_REDACTED` when the accepted arguments carry a
   * low-entropy term the entry declared (see `lowEntropyArgKeys` in `define.ts`):
   * the digest would be recoverable by offline enumeration, which ADR-004 §4 does
   * not permit a durable row to carry.
   */
  argsHash: string | null;
  /** sha256 of the canonical JSON of the projected rows. Null when none were produced. */
  resultHash: string | null;
  rowCount: number;
  /** UTF-8 byte length of the projected rows as canonical JSON. */
  byteCount: number;
  /** Wall-clock milliseconds spent inside the read-only transaction. */
  durationMs: number;
  /**
   * 0-based provider round this invocation belonged to, or `-1` when it belonged
   * to no round — an invocation refused before a round was ever opened. `-1` is
   * recorded honestly rather than coerced to 0: a durable row claiming round 0 for
   * a call that never entered the loop would misrepresent the audit trail.
   */
  roundIndex: number;
  observedAt: string;
}

/** A tool invocation that produced evidence. */
export interface DiagnosticsToolSuccess {
  schemaVersion: typeof DIAGNOSTICS_TOOL_SCHEMA_VERSION;
  status: "ok";
  toolId: string;
  /** Operator-facing label from the registry — server-owned, never model text. */
  label: string;
  rows: DiagnosticsToolRow[];
  /**
   * True when the tool's own row limit clipped the result. The model is told, so
   * it reports "the first N" rather than presenting a partial set as complete.
   */
  truncated: boolean;
  /**
   * The entry's server-owned sentence describing WHAT it searched (AID-6A, #2375).
   * Copied from the registry, never derived from a row or an argument.
   *
   * It exists because an empty result plus `not_found` reads as "there is no
   * evidence of this" — a wider claim than a tool with a narrow fixed filter is
   * entitled to make. A correlation entry, for instance, filters on a closed set of
   * audit categories that does NOT partition the same way the admin permission areas
   * do, so nothing-matched has to be qualified by the scope or the model will narrate
   * domain-wide absence from a category-shaped hole.
   */
  evidenceScope?: string;
  observedAt: string;
  audit: DiagnosticsToolAudit;
}

/** A tool invocation that produced nothing, and why. */
export interface DiagnosticsToolFailure {
  schemaVersion: typeof DIAGNOSTICS_TOOL_SCHEMA_VERSION;
  status: "error";
  toolId: string;
  reason: DiagnosticsToolFailureReason;
  /** Plain-English, safe to show an operator verbatim. NEVER echoes input. */
  message: string;
  /** Set only when the failure is a permission one (ADR-002 §3 partial answers). */
  missingAreas?: AdminPermissionArea[];
  observedAt: string;
  audit: DiagnosticsToolAudit;
}

export type DiagnosticsToolResult =
  | DiagnosticsToolSuccess
  | DiagnosticsToolFailure;

/**
 * Operator/model-facing copy for every failure reason. Centralised so the UI
 * (AID-7) and the evidence block render the SAME words the executor enforces,
 * and so no message can accidentally interpolate caller input.
 */
export const DIAGNOSTICS_TOOL_FAILURE_MESSAGES: Record<
  DiagnosticsToolFailureReason,
  string
> = {
  unknown_tool: "That diagnostics tool does not exist.",
  invalid_args:
    "The arguments for that diagnostics tool were not valid, so it was not run.",
  call_budget_exhausted:
    "This diagnostics session has used its allowance of tool calls. Ask a narrower question to start a fresh session.",
  metering_unavailable:
    "Diagnostics usage cannot be recorded at the moment, so no tool was run.",
  actor_unresolved:
    "Your account could not be found, so no diagnostics tool was run.",
  actor_blocked:
    "Your admin account is currently locked out, so no diagnostics tool was run.",
  actor_read_failed:
    "Your permissions could not be checked just now, so no diagnostics tool was run.",
  permission_denied:
    "You do not have view access to the area this diagnostics tool reads, so it was not run.",
  // ADR-004 §1's "personal detail omitted — include the record to see it", said in
  // plain English and naming the control the operator can actually reach. It never
  // names the record it was asked about: the whole point is that the record was not
  // included, and echoing an id back would put an unincluded identifier on screen.
  // It names BOTH controls and asserts NEITHER cause (#2785 delta review). One reason
  // covers three conditions — no record to resolve, a record outside the
  // investigation, and a record the operator DID select with the personal-details box
  // unticked — so a sentence that says "this question does not include the record"
  // tells an operator looking at their own selected record that they never selected
  // it, and sends them back to the picker instead of to the tick.
  sensitive_consent_required:
    "That diagnostics tool reads personal details, and this question does not both include the record it was asked about and allow that record's personal details to be read, so it was not run. Select that record and tick the personal-details box to see those details.",
  record_not_included:
    "That diagnostics tool reads one specific record, and this question does not include the record it was asked about, so it was not run. Select that record to see its history.",
  operator_action_required:
    "Searching for people or records needs your explicit go-ahead for this question, and it was not given, so that search was not run.",
  database_not_configured:
    "The read-only diagnostics database credential is not configured, so no tool was run.",
  database_role_unsafe:
    "The diagnostics database credential does not have the restricted, read-only privileges this feature requires, so no tool was run.",
  database_grants_missing:
    "The diagnostics database credential is missing one or more required read-only grants, so no tool was run.",
  query_failed:
    "That diagnostics read did not complete (it may have taken too long), so no results are available.",
  evidence_unavailable:
    "The system evidence that diagnostics tool reads could not be gathered just now, so no results are available.",
  evidence_database_busy:
    "The database was too busy to start that diagnostics read, so no results are available. Nothing is broken — try again shortly.",
  result_too_large:
    "That diagnostics read returned more data than this feature is allowed to handle. Ask a narrower question.",
  redaction_failed:
    "That diagnostics read could not be safely prepared, so its results were discarded.",
  audit_unavailable:
    "That diagnostics read could not be recorded in the audit trail, so its results were discarded.",
  internal_error:
    "Something went wrong running that diagnostics read, so no results are available.",
};
