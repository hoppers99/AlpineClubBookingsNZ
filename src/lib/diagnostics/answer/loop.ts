/**
 * AI Diagnostics — the BOUNDED ANSWER LOOP (AID-7, #2378).
 *
 * This is the module that makes the whole AID substrate reachable, and every control
 * it relies on already exists somewhere else on purpose. Its job is to sequence them
 * correctly and to refuse honestly; it holds no permission logic of its own.
 *
 * THE ORDER IS THE CONTRACT, and each step is owned elsewhere:
 *
 *   1. ROUND      `session.beginRound()` — ADR-005 §3's provider-round bound. Taken
 *                 BEFORE the reservation so an exhausted loop never reserves budget.
 *   2. RESERVE    `reserveDiagnosticsBudget()` — worst-case cents, concurrency-safe.
 *   3. ASK        `runDiagnosticsProviderRound()` — OUTSIDE any database transaction,
 *                 which is the metering contract's own requirement.
 *   4. SETTLE     `settleDiagnosticsRoundtrip()` — on SUCCESS AND ON FAILURE ALIKE.
 *   5. INVOKE     `invokeDiagnosticsTool()` per requested tool, on the model's channel
 *                 and with THIS question's consent ledger. Its ten gates are the
 *                 security boundary; nothing here may pre-empt or soften one.
 *   6. RENDER     `renderToolResultEvidence()` — the result becomes untrusted evidence
 *                 in a user turn, never an instruction and never an assistant claim.
 *
 * EVERY EXIT SETTLES WHAT IT RESERVED. A reservation released by nothing pins
 * worst-case budget until the TTL sweep reclaims it, so NOTHING that can throw sits
 * between the reserve and the settle: the tool list is built before the reservation,
 * the provider call is wrapped so a throw becomes the same typed failure any other
 * provider fault produces, and the settle runs unconditionally after it. The
 * reservation is the one piece of state in this loop that outlives the request.
 *
 * THE TOOL LIST IS REBUILT EVERY ROUND, and that is not a micro-optimisation in
 * reverse — it is required. `invoke.ts` gate 11 extends the consent ledger with records
 * DERIVED from a successful call, so an investigation that had no record at round 0 may
 * legitimately have one at round 1, and `definitions.ts` filters per-record entries on
 * exactly that (`consent.size === 0` offers none). A list built once would keep offering
 * the round-0 answer for the rest of the conversation.
 *
 * WHAT IT REFUSES TO DO. It never retries a provider call (see `provider.ts`), never
 * infers around a refusal, never persists a transcript, and never treats a tool failure
 * as a reason to stop: a denial is evidence, and the model is required to report it.
 */

import "server-only";

import type { AdminPermissionArea, AdminPermissionMatrix } from "@/lib/admin-permissions";
import {
  DIAGNOSTICS_MAX_TOOL_ROUNDS,
  reserveDiagnosticsBudget,
  settleDiagnosticsRoundtrip,
} from "@/lib/ai-diagnostics-usage";
import { reportAiError } from "@/lib/observability-bridge";

import {
  createDiagnosticCase,
  recordCaseEvidence,
  summariseDiagnosticCase,
  type DiagnosticCaseSummary,
} from "../case/case";
import {
  DIAGNOSTICS_EVIDENCE_STATE_DESCRIPTIONS,
  worstEvidenceState,
  type DiagnosticsEvidenceState,
} from "../case/states";
import type { DiagnosticsConsentLedger } from "../tools/consent";
import { listDiagnosticsToolDefinitions } from "../tools/definitions";
import { invokeDiagnosticsTool } from "../tools/invoke";
import { diagnosticsToolRequiresProviderCheck } from "../tools/registry";
import { renderToolResultEvidence } from "../tools/render";
import type { DiagnosticsToolSession } from "../tools/session";
import {
  buildDiagnosticsConversationBlock,
  buildDiagnosticsQuestionBlock,
  type DiagnosticsPriorTurn,
} from "./prompt";
import {
  DIAGNOSTICS_MODEL,
  runDiagnosticsProviderRound,
  type DiagnosticsProviderErrorCode,
  type DiagnosticsProviderResult,
} from "./provider";

import type Anthropic from "@anthropic-ai/sdk";

/** The surface label written to the durable metering and audit rows. */
const SURFACE = "ai-diagnostics-ask";

/**
 * Why an answer could not be produced. Each maps to its own operator sentence and its
 * own next action — that is the whole reason this is a closed union rather than a
 * boolean, and why #2378 requires the failure states to be "first-class UX".
 */
export type DiagnosticsAnswerFailureReason =
  /** The monthly budget is spent or unset. Nothing was sent to the provider. */
  | "budget_exhausted"
  /** Metering is unhealthy: can't-record ⇒ don't-spend. */
  | "metering_unavailable"
  /** The provider refused the request outright. */
  | "provider_refused"
  /** The provider was rate-limited or overloaded. Retrying later is reasonable. */
  | "provider_busy"
  /** The provider could not be reached, or the stored key is bad. */
  | "provider_unavailable"
  /** The loop used every round it is allowed and never reached a final answer. */
  | "round_limit_reached"
  /** The provider returned nothing usable. */
  | "no_answer";

/**
 * One evidence source, as the OPERATOR is shown it (owner decision D10).
 *
 * It carries no rows and no arguments — provenance is about WHERE an answer came from,
 * not a second copy of the evidence. The model already received the rows; repeating
 * them under the answer would be a second, unredacted rendering of the same personal
 * data on the same screen.
 */
export interface DiagnosticsAnswerSource {
  toolId: string;
  /** Human-readable purpose, from the registry. Never a raw id alone. */
  label: string;
  state: DiagnosticsEvidenceState;
  /** The server-owned operator sentence for that state. */
  stateDescription: string;
  /** ISO instant the evidence was read. */
  observedAt: string;
  rowCount: number;
  /** Areas that would unlock this source, for a permission denial only. */
  missingAreas: AdminPermissionArea[];
}

export interface DiagnosticsAnswer {
  ok: true;
  answer: string;
  /** The provider hit its output ceiling; the UI says the answer was shortened. */
  truncated: boolean;
  sources: DiagnosticsAnswerSource[];
  /** The case's own account of what it did and did not establish. */
  summary: DiagnosticCaseSummary;
  /** Rounds actually used, for the operator-facing "how hard did it look" line. */
  roundsUsed: number;
}

export type DiagnosticsAnswerResult =
  | DiagnosticsAnswer
  | {
      ok: false;
      reason: DiagnosticsAnswerFailureReason;
      /** Sources gathered before the failure. A partial investigation still explains itself. */
      sources: DiagnosticsAnswerSource[];
      summary: DiagnosticCaseSummary;
      roundsUsed: number;
    };

export interface RunDiagnosticsAnswerInput {
  apiKey: string;
  /** The admin asking, derived server-side from the session. Never client-supplied. */
  actingMemberId: string;
  /** Their freshly-read matrix, for the tool OFFER list only — `invoke.ts` re-reads. */
  matrix: AdminPermissionMatrix;
  question: string;
  /** Prior turns from the browser. UNTRUSTED — replayed as data, never as authority. */
  priorTurns: readonly DiagnosticsPriorTurn[];
  /** THIS question's ledger. A new question must build a new one; the ledger enforces it. */
  consent: DiagnosticsConsentLedger;
  /** THIS question's bounded loop. */
  session: DiagnosticsToolSession;
  /**
   * Already-rendered evidence blocks for the deployed code (AID-3) and the page the
   * operator is on (AID-4). Rendered by their own modules, which own their wrappers
   * and their neutralisation; this loop only places them in the first user turn.
   */
  sourceBlock?: string;
  pageContextBlock?: string;
}

/** Map a provider error to the operator-facing failure. */
function failureForProviderError(
  code: DiagnosticsProviderErrorCode,
): DiagnosticsAnswerFailureReason {
  switch (code) {
    case "refusal":
      return "provider_refused";
    case "rate_limited":
    case "overloaded":
      return "provider_busy";
    // `auth` joins the unavailable group deliberately: a bad stored key is an
    // operator-fixable configuration fault, but naming it to whoever happens to be
    // asking tells them about the deployment's credentials. The route bridges the
    // real cause to Sentry instead, exactly as the help route does.
    case "auth":
    case "timeout":
    case "invalid_request":
    case "unknown":
      return "provider_unavailable";
  }
}

export async function runDiagnosticsAnswer(
  input: RunDiagnosticsAnswerInput,
): Promise<DiagnosticsAnswerResult> {
  const diagnosticCase = createDiagnosticCase("operator.question");
  const sources: DiagnosticsAnswerSource[] = [];
  let roundsUsed = 0;

  /** The first user turn: the question last, after the evidence it is asked about. */
  const openingParts: string[] = [];
  if (input.sourceBlock) openingParts.push(input.sourceBlock);
  if (input.pageContextBlock) openingParts.push(input.pageContextBlock);
  const conversation = buildDiagnosticsConversationBlock(input.priorTurns);
  if (conversation) openingParts.push(conversation);
  openingParts.push(buildDiagnosticsQuestionBlock(input.question));

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: openingParts.join("\n\n") },
  ];

  const finish = (
    reason: DiagnosticsAnswerFailureReason,
  ): DiagnosticsAnswerResult => ({
    ok: false,
    reason,
    sources,
    summary: summariseDiagnosticCase(diagnosticCase),
    roundsUsed,
  });

  for (let round = 0; round < DIAGNOSTICS_MAX_TOOL_ROUNDS; round += 1) {
    // 1. ROUND. Before the reservation, so an exhausted loop never reserves.
    const opened = input.session.beginRound();
    if (!opened.ok) return finish("round_limit_reached");

    // 2. THE OFFER LIST — rebuilt per round, and BEFORE the reservation. Per round
    // because a successful call may have widened the investigation: a per-record
    // entry that was correctly withheld at round 0 becomes offerable once the ledger
    // holds a record (see the module docblock). Before the reservation because this
    // call is the one thing in the round the try/catch below does not cover — built
    // here, a throw from it exits with nothing reserved, instead of stranding
    // worst-case budget until the TTL sweep.
    const tools = listDiagnosticsToolDefinitions(input.matrix, input.consent);

    // 3. RESERVE.
    const reservation = await reserveDiagnosticsBudget();
    if (!reservation.ok) {
      return finish(
        reservation.reason === "metering_unavailable"
          ? "metering_unavailable"
          : "budget_exhausted",
      );
    }

    // 4 + 5. ASK, then SETTLE WHATEVER HAPPENED.
    //
    // The catch is not decoration. `runDiagnosticsProviderRound` documents itself as
    // never throwing, and today it does not — but the reservation is the one piece of
    // state in this loop that outlives the request, and an escaping exception between
    // the reserve and the settle strands worst-case budget until the TTL sweep
    // reclaims it. So a throw is converted into the same typed failure any other
    // provider fault produces, and the settle below runs unconditionally on the way
    // out. The alternative — trusting a docblock on another module to stay true — is
    // the exact habit this codebase keeps paying for.
    const startedAt = Date.now();
    let response: DiagnosticsProviderResult;
    try {
      response = await runDiagnosticsProviderRound({
        apiKey: input.apiKey,
        messages,
        tools,
      });
    } catch (err) {
      reportAiError({
        tag: "diagnostics-answer-provider",
        message: "The diagnostics provider round threw instead of returning a typed failure",
        err,
        context: { surface: SURFACE, roundIndex: opened.roundIndex },
      });
      response = { ok: false, code: "unknown" };
    }
    const durationMs = Date.now() - startedAt;
    roundsUsed = round + 1;

    await settleDiagnosticsRoundtrip({
      reservationId: reservation.reservationId,
      adminMemberId: input.actingMemberId,
      surface: SURFACE,
      model: DIAGNOSTICS_MODEL,
      roundIndex: opened.roundIndex,
      success: response.ok,
      usage: response.usage,
      errorCode: response.ok ? null : response.code,
      durationMs,
    });

    if (!response.ok) {
      if (response.code === "auth") {
        // The stored diagnostics key is bad and an operator must re-enter it. Bridged
        // here rather than returned: see `failureForProviderError`. No question text.
        reportAiError({
          tag: "diagnostics-answer-auth",
          message:
            "AI Diagnostics provider rejected the API key (authentication error) — re-enter the diagnostics Anthropic key",
          context: { surface: SURFACE },
        });
      }
      return finish(failureForProviderError(response.code));
    }

    // A round with no tool calls is the final answer.
    if (!response.wantsTools) {
      const answer = response.text;
      if (!answer) return finish("no_answer");
      return {
        ok: true,
        answer,
        truncated: response.truncated,
        sources,
        summary: summariseDiagnosticCase(diagnosticCase),
        roundsUsed,
      };
    }

    // 6 + 7. Run what it asked for. The provider's own content is replayed in the
    // `assistant` role — see `DiagnosticsProviderResponse.assistantContent` for why
    // that is correct HERE and refused for client-supplied turns.
    messages.push({ role: "assistant", content: response.assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of response.toolUses) {
      const result = await invokeDiagnosticsTool({
        toolId: toolUse.name,
        args: toolUse.input,
        actingMemberId: input.actingMemberId,
        session: input.session,
        // THE MODEL'S CHANNEL, always. `operator_action` is the operator's own record
        // picker and nothing in this loop is that — passing it here would hand the
        // model the operator's authority and disable gate 4a, which is the control the
        // per-request people-search tick rests on (owner decision Q2).
        invocationChannel: "model_tool_use",
        consent: input.consent,
        surface: SURFACE,
      });

      const evidence = renderToolResultEvidence(result);
      // The state the BLOCK asserts, not the retrieval state — `render.ts` is explicit
      // that using the latter beside a clipped block is what produced
      // `evidence-state="ok"` above an incomplete listing.
      //
      // STORED PROVIDER EVIDENCE IS NEVER PRESENTED AS `ok` (#2815). A finance tool
      // whose scope carries the stored-provider disclosure read what this platform
      // last WROTE DOWN, not what Stripe or Xero believe right now — and `states.ts`
      // names THIS surface as `provider_check_required`'s producer, folded with
      // `worstEvidenceState`. The fold applies only where the block asserts `ok`:
      // every other state already names a more specific problem (truncation, denial,
      // nothing matched), and one state per source means the more actionable caveat
      // must win. AID-7 shipped without this and its contract review caught stored
      // `SUCCEEDED` rows presenting as live truth.
      const presentedState =
        evidence.evidenceState === "ok" &&
        diagnosticsToolRequiresProviderCheck(result.toolId)
          ? worstEvidenceState(evidence.evidenceState, "provider_check_required")
          : evidence.evidenceState;
      const outcome = recordCaseEvidence(
        diagnosticCase,
        result,
        presentedState,
      );
      sources.push({
        toolId: result.toolId,
        // A failure result carries no label — it may never have identified an entry —
        // so the id stands in. It is a registry key or the literal `unknown`, both of
        // which `invoke.ts` guarantees are safe to show.
        label: result.status === "ok" ? result.label : result.toolId,
        state: outcome.state,
        stateDescription: DIAGNOSTICS_EVIDENCE_STATE_DESCRIPTIONS[outcome.state],
        observedAt: result.observedAt,
        rowCount: outcome.rowCount,
        missingAreas: [...outcome.missingAreas],
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: evidence.block,
        // NOT `is_error`, even for a refusal, and the choice is deliberate. A
        // permission denial or a withheld consent is not a malfunction to be retried —
        // it is the evidence that stops the model inventing an answer, and the system
        // prompt requires it to be reported. Flagging it as an error invites a retry
        // loop against gates that will refuse identically, spending rounds to learn
        // what the block already said.
        is_error: false,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Every round used and still asking for tools.
  return finish("round_limit_reached");
}
