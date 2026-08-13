"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Stethoscope } from "lucide-react";

import {
  DIAGNOSTICS_WIRE_BOUNDS,
  type DiagnosticsAskRequest,
} from "@/lib/diagnostics/answer/contract";
import { DIAGNOSTICS_PAGE_CONTEXT_BOUNDS } from "@/lib/diagnostics/page-context/types";
import { DIAGNOSTICS_TOOL_CONSENT_COPY } from "@/lib/diagnostics/tools/consent";

import { DiagnosticsProvenance } from "./diagnostics-provenance";
import {
  DIAGNOSTICS_STILL_WORKING_AFTER_MS,
  type UseDiagnosticsChat,
} from "./use-diagnostics-chat";

/**
 * THE DIAGNOSTICS SURFACE INSIDE THE HELP BUBBLE (AID-7, #2378; owner decisions D8-D10,
 * 12 Aug 2026).
 *
 * IT SHARES AN ENTRY POINT WITH PAGE HELP; IT IS NOT PAGE HELP. #2378 is explicit that
 * AI Diagnostics is "a separate read-only admin investigation product, not Page Help
 * with a different label", and the Q4 correction did not change that — it made the
 * bubble a shared doorway. So this is its own tab, with its own conversation, its own
 * consent controls, its own endpoint and its own provenance. Nothing here is wired to
 * `useHelpChat`, and the two transcripts never mix.
 *
 * WHY ASKING LIVES HERE AND NOT ON THE PAGE (owner decision D8). The page at
 * `/admin/ai-diagnostics` owns setup and status; all asking happens in the bubble, on
 * whichever admin screen the operator is looking at — so the consent tick, the evidence
 * display and the transcript hardening are built and reviewed in ONE place rather than
 * two that drift. It is also why this component shows NO readiness detail: a second
 * readiness surface here is precisely the drift D8 rules out, so a deployment that is
 * not ready says so through the server's own refusal copy, which points at the page.
 *
 * THE TICKS ARE PER QUESTION AND START UNTICKED (owner decision D9). What the operator
 * sees matches exactly what the server enforces: AID-7a grants both permissions per
 * REQUEST, so a tick that looked session-wide would be this component claiming an
 * authority the gate does not give it. `useDiagnosticsChat` clears them after every
 * send, including a failed one.
 */

/**
 * FALLBACK view state, read from the URL at ask time (#2816).
 *
 * The primary channel is the page's own PUBLISHED APPLIED state (owner decision
 * 13 Aug 2026) — post-parse values, defaults included — via
 * `usePublishDiagnosticsViewState`. This URL read covers only pages that publish
 * nothing: better than no context, but it is the operator's ADDRESS, not
 * necessarily what the page applied, which is exactly why publication wins.
 *
 * SENT RAW, FILTERED SERVER-SIDE (registry-row allowlists; enum casing
 * normalised there). Client-side rules mirror the server where silence would
 * misrepresent: an overlong value is DROPPED, never truncated — a truncated
 * filter value would tell the model the operator filtered by something they did
 * not — and on a repeated key the FIRST value wins, matching how every page
 * reads its own params (`.get()`), because pages given a repeated key either
 * take the first or reject the lot.
 */
function viewFromLocationSearch():
  | NonNullable<DiagnosticsAskRequest["view"]>
  | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const view: NonNullable<DiagnosticsAskRequest["view"]> = {};
  const filters: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let kept = 0;
  let hasFilters = false;
  for (const [key, rawValue] of params.entries()) {
    if (kept >= DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.maxFilters * 2) break;
    const value = rawValue.trim();
    if (
      !value ||
      value.length > DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.filterValueMaxChars ||
      key.length > DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.filterKeyMaxChars
    ) {
      continue;
    }
    if (key === "tab") {
      if (view.tab === undefined) view.tab = value;
    } else if (key === "step") {
      if (view.step === undefined) view.step = value;
    } else if (key === "status") {
      if (view.status === undefined) view.status = value;
    } else if (key === "errorCode") {
      if (view.errorCode === undefined) view.errorCode = value;
    } else if (!(key in filters)) {
      filters[key] = value;
      hasFilters = true;
      kept += 1;
    }
  }
  if (hasFilters) view.filters = { ...filters };
  return Object.keys(view).length > 0 ? view : undefined;
}

/**
 * The screen the conversation was MOST RECENTLY asked from, when it is not this one.
 *
 * The last operator turn, not the first: ask on bookings, move to payments, ask
 * again, move back to bookings — the first-turn version showed no notice there,
 * even though the immediately preceding answer was about payments. What the
 * sentence claims ("answers from here on are about this screen") is a statement
 * about the previous QUESTION's screen, so that is what it keys on.
 */
function movedScreenNotice(
  messages: UseDiagnosticsChat["messages"],
  pathname: string,
): string | null {
  const last = [...messages]
    .reverse()
    .find((message) => message.role === "operator");
  if (!last?.pathname || last.pathname === pathname) return null;
  return `Your last question was asked from ${last.pathname}. Answers from here on are about the screen you are on now.`;
}

export function DiagnosticsView({
  chat,
  pathname,
  moduleEnabled,
  recordId,
  publishedView,
}: {
  chat: UseDiagnosticsChat;
  pathname: string;
  moduleEnabled: boolean;
  /** The record the page registered as open, when the address does not name one. */
  recordId?: string;
  /** The page's PUBLISHED applied view state (#2816). Wins over the URL fallback. */
  publishedView?: DiagnosticsAskRequest["view"];
}) {
  const [draft, setDraft] = useState("");
  const searchTickId = useId();
  const recordTickId = useId();
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest turn in view as the conversation grows. `block: "nearest"` so it
  // scrolls the panel's own overflow container and never the page behind it.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [chat.messages.length, chat.pending]);

  const stillWorking =
    chat.pending && chat.elapsedMs >= DIAGNOSTICS_STILL_WORKING_AFTER_MS;
  const elapsedSeconds = Math.floor(chat.elapsedMs / 1000);
  const moved = movedScreenNotice(chat.messages, pathname);

  if (!moduleEnabled) {
    // The one state the bubble answers itself, because the operator would otherwise
    // type a question into a box that could only ever refuse it. Everything else is
    // the server's own refusal copy — see the docblock on the D8 split.
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="font-medium">AI Diagnostics is switched off</p>
        <p className="text-muted-foreground">
          It cannot answer questions until someone who can manage Feature modules
          turns it on.
        </p>
        {/* Feature modules, NOT /admin/ai-diagnostics: this same PR put that page
            behind the aiDiagnostics feature-route rule, so it 404s exactly when
            this panel is on screen. The contract review (13 Aug 2026) caught the
            first cut linking there — the panel's only call to action was a dead
            end. The budget card already links here for the same reason. */}
        <Link className="underline" href="/admin/modules">
          Open Feature modules
        </Link>
      </div>
    );
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question) return;
    setDraft("");
    // THE PRECEDENCE, and there are only these two paths (owner decision,
    // 13 Aug 2026):
    //
    //   a published object  the page's APPLIED state, and it is the answer even
    //                       when it is EMPTY. A wired page that applied no
    //                       filters publishes `{}`, and that must SUPPRESS the
    //                       address read rather than invite it — the page has
    //                       already said the address is not the state, which is
    //                       exactly the case where the address is a lie (a
    //                       malformed parameter the page's parser rejected, so
    //                       the list is unfiltered while the URL still shows
    //                       every filter).
    //   nothing published   the URL fallback, for pages nobody has wired.
    //
    // An empty view is then dropped rather than sent: `view: {}` costs a wire
    // field and tells the model nothing.
    const view = publishedView ?? viewFromLocationSearch();
    const hasView = view !== undefined && Object.keys(view).length > 0;
    void chat.ask(question, {
      pathname,
      ...(recordId ? { recordId } : {}),
      ...(hasView ? { view } : {}),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-md bg-muted p-2 text-xs text-muted-foreground">
        <Stethoscope aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Ask why something is in the state it is in — this booking, this member,
          this payment. Diagnostics reads and explains; it never changes anything.
        </p>
      </div>

      {moved ? (
        // NOT a security control, and it does not pretend to be one. The server
        // re-derives the page context from the CURRENT pathname on every request, so
        // the evidence is always about the screen the operator is on. This only tells
        // them that the conversation above began somewhere else, which is the honest
        // version of the issue's "stale page context" state for a bubble that follows
        // the operator around the admin panel.
        <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
          {moved}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {chat.messages.map((message) => (
          <div
            key={message.id}
            data-testid={`diagnostics-message-${message.role}`}
            className={
              message.role === "operator"
                ? "self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                : "rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
            }
          >
            <p className="whitespace-pre-wrap">{message.text}</p>
            {message.truncated ? (
              <p className="mt-1 text-xs text-muted-foreground">
                That answer was shortened. Ask a follow-up if you need the rest.
              </p>
            ) : null}
            {message.provenance ? (
              <DiagnosticsProvenance provenance={message.provenance} />
            ) : null}
          </div>
        ))}

        {/* THE "STILL WORKING" STATE (#2804, owner decision 12 Aug 2026).
            A diagnostics read may wait ~15 s for a busy database, and the owner
            accepted that only on condition the wait never reaches a screen without a
            progress state. It appears well before that worst case.

            `role="status"` with `aria-live="polite"` announces it without interrupting,
            and the elapsed count is in `aria-hidden` text so a screen reader hears the
            sentence once rather than a new number every second — the issue names that
            exact failure ("live/status announcements that do not turn streaming/status
            noise into an accessibility problem").

            It never suggests reloading: a reload during contention adds another queued
            reader and makes the cause worse, which is the failure this state exists to
            prevent. */}
        {chat.pending ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="diagnostics-pending"
            className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
          >
            {stillWorking ? (
              <>
                <span>
                  Still working — reading the system and waiting for a free database
                  connection. This can take a few seconds longer when the club is busy.
                </span>
                <span aria-hidden="true" className="ml-1 tabular-nums">
                  ({elapsedSeconds}s)
                </span>
              </>
            ) : (
              <span>Looking into that…</span>
            )}
          </div>
        ) : null}
        <div ref={threadEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        {/* THE TWO PER-QUESTION TICKS. The labels and descriptions are the SERVER's
            own words (`DIAGNOSTICS_TOOL_CONSENT_COPY`), imported rather than retyped,
            because that module says why in as many words: "a checkbox whose label
            disagrees with the server's behaviour is worse than no checkbox." */}
        <fieldset className="flex flex-col gap-2 rounded-md border border-border p-2">
          <legend className="px-1 text-xs font-medium text-muted-foreground">
            For this question only
          </legend>

          <div className="flex items-start gap-2">
            <input
              id={recordTickId}
              type="checkbox"
              checked={chat.allowRecordPersonalDetails}
              onChange={(event) =>
                chat.setAllowRecordPersonalDetails(event.target.checked)
              }
              data-testid="diagnostics-consent-record"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
            />
            <label htmlFor={recordTickId} className="text-xs">
              <span className="font-medium text-foreground">
                {DIAGNOSTICS_TOOL_CONSENT_COPY.record.label}
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                {DIAGNOSTICS_TOOL_CONSENT_COPY.record.description}
              </span>
            </label>
          </div>

          <div className="flex items-start gap-2">
            <input
              id={searchTickId}
              type="checkbox"
              checked={chat.allowPeopleSearch}
              onChange={(event) => chat.setAllowPeopleSearch(event.target.checked)}
              data-testid="diagnostics-consent-search"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
            />
            <label htmlFor={searchTickId} className="text-xs">
              <span className="font-medium text-foreground">
                {DIAGNOSTICS_TOOL_CONSENT_COPY.search.label}
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                {DIAGNOSTICS_TOOL_CONSENT_COPY.search.description}
              </span>
            </label>
          </div>
        </fieldset>

        {/* THE DISCLOSURE (owner decision, 13 Aug 2026): the operator's current
            page filters — including a typed search — travel with every question,
            with NEITHER tick gating them. The decision was to always send and SAY
            SO, so the sentence sits beside the input where the sending happens,
            not in a doc nobody re-reads.

            It says "on this page" rather than "that this page applied" because
            both are true at once: a wired page publishes what it applied, and an
            unwired one falls back to the address. And it names the ticks, because
            a control that sits directly above something it does not govern is
            read as governing it. */}
        <p
          data-testid="diagnostics-view-disclosure"
          className="px-1 text-xs text-muted-foreground"
        >
          The filters and search on this page — including anything you have typed
          into a search box — travel with your question, so Diagnostics can see
          the list you are looking at. The boxes above do not affect that.
        </p>

        <label htmlFor="diagnostics-question" className="sr-only">
          Ask diagnostics a question
        </label>
        <textarea
          id="diagnostics-question"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          maxLength={DIAGNOSTICS_WIRE_BOUNDS.questionMaxChars}
          disabled={chat.budgetExhausted}
          data-testid="diagnostics-input"
          placeholder="Why will this booking not confirm?"
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={chat.reset}
            disabled={chat.messages.length === 0 || chat.pending}
            className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Start again
          </button>
          <button
            type="submit"
            disabled={chat.pending || chat.budgetExhausted || draft.trim().length === 0}
            data-testid="diagnostics-send"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Ask
          </button>
        </div>
      </form>
    </div>
  );
}
