/**
 * AI Diagnostics — the ASK WIRE CONTRACT (AID-7, #2378).
 *
 * One module both ends import, so the browser and the route cannot disagree about
 * what a question looks like or what an answer contains. The client imports TYPES
 * only; the schema and every server-side decision stay behind `route.ts`.
 *
 * THE CLIENT SENDS SELECTORS, NEVER FACTS. Everything in the request is either the
 * operator's own words, one of their two per-question ticks, or a pointer to the page
 * they are on. There is no field for a record's contents, a permission, an actor, a
 * role or a consent decision — those are established server-side on every request, and
 * a field that carried one would be a field an attacker could set. The owner's 3 Aug
 * directive states it plainly: "client-provided route and record values are selectors
 * only. The server must revalidate them, re-check current permissions and re-fetch only
 * the approved bounded projection."
 *
 * THE TICKS ARE PER REQUEST, AND THE WIRE SHAPE IS WHY THAT IS ENFORCEABLE (owner
 * decision D9, 12 Aug 2026). Both live on the request body, not in a cookie, a session
 * or a server-held conversation. The identical question tomorrow, or the next turn of
 * this conversation, carries whatever the operator ticked THEN — because there is
 * nowhere else for the value to have been kept.
 */

import type { AdminPermissionArea } from "@/lib/admin-permissions";

import type { DiagnosticsEvidenceState } from "../case/states";
import type { DiagnosticsConsentRecordKind } from "../tools/types";
import type { DiagnosticsRecordKind } from "../page-context/types";

/**
 * Every page-context record kind, mapped to the consent kind it seeds.
 *
 * A TOTAL MAP RATHER THAN AN ASSIGNMENT, and it earns its keep the day the two lists
 * stop being identical. They are both `booking | member | payment` today, so a bare
 * assignment compiles and a reviewer reads it as safe — but `DIAGNOSTICS_RECORD_KINDS`
 * (page-context, ADR-003) and `DIAGNOSTICS_CONSENT_RECORD_KINDS` (the ledger, ADR-004
 * §1) are owned by different modules for different reasons, and nothing stops one
 * gaining `family_group` first. If it does, the assignment silently seeds a ledger
 * entry of a kind the ledger cannot hold, and the refusal surfaces two layers away as
 * an unexplained `consent_required`. This map fails to compile instead.
 */
export const CONSENT_KIND_FOR_PAGE_RECORD: Record<
  DiagnosticsRecordKind,
  DiagnosticsConsentRecordKind
> = {
  booking: "booking",
  member: "member",
  payment: "payment",
};

/** One prior turn, as the browser holds it. Untrusted on arrival. */
export interface DiagnosticsAskTurn {
  role: "operator" | "assistant";
  text: string;
}

export interface DiagnosticsAskRequest {
  /** The admin screen the operator is asking from. A selector, re-resolved server-side. */
  pathname: string;
  question: string;
  /** In-memory conversation from the browser. Replayed as untrusted data only. */
  transcript: DiagnosticsAskTurn[];
  /**
   * The operator's two per-question ticks. Both default OFF at every layer, and both
   * cover THIS request only.
   */
  allowPeopleSearch: boolean;
  allowRecordPersonalDetails: boolean;
  /**
   * The record the operator has open, when the page is a LIST rather than a detail
   * URL — there is no `/admin/bookings/[id]` in this codebase, so without this the
   * product could not answer its own flagship question.
   *
   * THERE IS NO ROUTE KEY HERE, and its absence is the design: the server derives the
   * route from `pathname`, because naming the route key would be naming the record
   * KIND, and `page-context/registry.ts` keeps that server-side on purpose — "a member
   * id sent on a booking route can only ever fail to find a booking, never read a
   * member." The id is a selector the server re-resolves under the operator's own
   * authority; the kind is never the client's to choose.
   */
  recordId?: string;
  /**
   * The operator's allowlisted VIEW state on that page — the tab they have open, the
   * status they filtered to.
   */
  view?: {
    tab?: string;
    step?: string;
    status?: string;
    errorCode?: string;
    filters?: Record<string, string>;
  };
}

/** Why an ask was refused before the model was ever reached. */
export type DiagnosticsAskBlockedReason =
  | "not_ready"
  | "not_configured"
  | "budget_exhausted"
  | "metering_unavailable"
  | "rate_limited"
  | "provider_busy"
  | "provider_unavailable"
  | "provider_refused"
  | "round_limit_reached"
  | "no_answer";

/** One evidence source as the operator is shown it (owner decision D10). */
export interface DiagnosticsAskSource {
  toolId: string;
  label: string;
  state: DiagnosticsEvidenceState;
  stateDescription: string;
  observedAt: string;
  rowCount: number;
  missingAreas: AdminPermissionArea[];
}

/**
 * THE COLLAPSED PROVENANCE LINE AND ITS HONESTY MARKERS (owner decision D10).
 *
 * The markers are computed on the SERVER and travel as booleans, rather than being
 * derived in the browser from the source list. D10 requires that "something could not
 * be read" and "this was stale" appear in the COLLAPSED line — the expander is for
 * detail, not for the existence of a caveat — and a caveat that a component has to
 * re-derive is a caveat a future refactor of that component can drop. The server
 * already computed it once, from `summariseDiagnosticCase`.
 */
export interface DiagnosticsAskProvenance {
  /** The one-line summary, server-built. Always present when an answer is. */
  line: string;
  /** At least one source was withheld, truncated, stale or unreadable. */
  hasCaveat: boolean;
  /** Something could not be read for want of an admin AREA. */
  hasPermissionWithheld: boolean;
  /** Something was not read because the record was not included / details not ticked. */
  hasConsentWithheld: boolean;
  /** A search was refused because the people-search tick was off. */
  hasSearchWithheld: boolean;
  /** At least one source returned only part of a longer result. */
  hasPartialEvidence: boolean;
  /** Evidence was read earlier in this conversation and may have moved on. */
  hasStaleEvidence: boolean;
  /** Areas that would complete the picture. Permission denials only. */
  withheldAreas: AdminPermissionArea[];
  sources: DiagnosticsAskSource[];
  roundsUsed: number;
}

export type DiagnosticsAskResponse =
  | {
      status: "answered";
      answer: string;
      /** The provider hit its output ceiling. */
      truncated: boolean;
      provenance: DiagnosticsAskProvenance;
    }
  | {
      status: "blocked";
      reason: DiagnosticsAskBlockedReason;
      /** Server-owned operator sentence. The UI never invents one. */
      message: string;
      /** What the operator can do next, when there is something. */
      nextStep?: string;
      /** Evidence gathered before the block, so a partial run still explains itself. */
      provenance?: DiagnosticsAskProvenance;
    };

/**
 * The operator-facing sentence and next step for every blocked reason.
 *
 * SERVER-OWNED, and a total record so a new reason cannot ship without one. The UI
 * renders `message`/`nextStep` verbatim: a client that composed its own wording would
 * be a second place for these sentences to live, and the one that drifts is always the
 * one nobody is reading when the incident happens.
 *
 * None of them invites a RELOAD, which is a requirement rather than a style choice
 * (#2804, owner decision 12 Aug 2026): a reload during database contention adds another
 * queued reader and makes the cause worse. "Try again shortly" is a deliberate,
 * different instruction from "refresh the page".
 */
export const DIAGNOSTICS_ASK_BLOCKED_COPY: Record<
  DiagnosticsAskBlockedReason,
  { message: string; nextStep?: string }
> = {
  not_ready: {
    message:
      "Diagnostics is not ready to answer questions in this deployment yet.",
    nextStep:
      "Open Admin → AI Diagnostics to see what is still needed, or ask someone with support access to finish the setup.",
  },
  not_configured: {
    message: "Diagnostics has not been given its own API key yet.",
    nextStep:
      "Someone with support access can add it in Admin → AI Diagnostics.",
  },
  budget_exhausted: {
    message:
      "Diagnostics has reached this month's spending limit, so it cannot answer any more questions right now.",
    nextStep:
      "Someone who can manage the diagnostics budget can raise it in Admin → AI Diagnostics.",
  },
  metering_unavailable: {
    message:
      "Diagnostics cannot record what it spends at the moment, so it will not spend anything.",
    nextStep: "Try again shortly. If it persists, someone with support access should check the diagnostics settings.",
  },
  rate_limited: {
    message: "That is a lot of questions in a short time.",
    nextStep: "Wait a minute or two and ask again.",
  },
  provider_busy: {
    message: "The assistant is busy or rate-limited just now.",
    nextStep: "Wait a moment and ask again.",
  },
  provider_unavailable: {
    message: "The assistant could not be reached.",
    nextStep:
      "Try again shortly. If it keeps happening, someone with support access should check the diagnostics settings.",
  },
  provider_refused: {
    message: "The assistant declined to answer that question.",
    nextStep: "Try asking it a different way, or more specifically.",
  },
  round_limit_reached: {
    message:
      "The assistant gathered evidence up to its limit for one question without reaching an answer.",
    nextStep:
      "Ask a narrower question — about one booking, member or payment at a time.",
  },
  no_answer: {
    message: "The assistant did not return an answer.",
    nextStep: "Try asking it again, or more specifically.",
  },
};
