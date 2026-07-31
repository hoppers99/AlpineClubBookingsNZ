"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MEMBER_GUEST_FIND_COPY,
  classifyMemberGuestFindInput,
  describeHouseholdCandidatePrompt,
  hasIndistinguishableMemberGuestCandidates,
  shouldAutoResolveMemberGuestCandidate,
  type MemberGuestCandidate,
  type MemberGuestCandidateResponse,
} from "@/lib/member-guest-find";

/**
 * The inline "+ Add Member Guest" find panel (epic #2305, MG3 #2308).
 *
 * **INLINE, NOT A DIALOG** — owner sign-off answer 3, and the reason it is worth
 * stating: the booker keeps sight of their existing guests and the guest limit
 * while they search, and a pop-up inside a multi-step form is awkward on a phone
 * and a known trap for keyboard and screen-reader users.
 *
 * **ONE BOX THAT TAKES EITHER** — owner sign-off answer 2. If what the member
 * typed parses as an email address it is resolved exactly by the email path;
 * otherwise, and only where the club has turned open search on, it searches
 * names. There is no mode switch. With open search OFF the box is an email box
 * and says so.
 *
 * WHAT THIS COMPONENT MAY NOT DO, and it is a short list because the server
 * enforces all of it anyway: it must not filter candidates on anything the
 * server did not filter on (that would be a client-side eligibility rule the
 * server does not share), and it must not show a member anything beyond the four
 * fields the server sent. The only client-side filtering here is disabling rows
 * for people already in the party — which the server deliberately does NOT do,
 * because filtering them out server-side would leak "this person is already on
 * your booking" by absence.
 */

const SEARCH_DEBOUNCE_MS = 300;

export interface MemberGuestFindPanelProps {
  /** Whether the club turned the name type-ahead on. Decoration only — the routes re-check. */
  openSearchEnabled: boolean;
  /** Member ids already in the party, so their rows render disabled rather than vanishing. */
  existingMemberIds: readonly string[];
  /** True when the party is already at the lodge capacity. */
  atCapacity: boolean;
  onAdd: (candidate: MemberGuestCandidate) => void;
  onCancel: () => void;
  /**
   * The server's refusal after "Add to booking", if there was one. D-8 neutral:
   * one sentence, whatever the real reason.
   */
  addError?: string | null;
}

type PanelState =
  | { kind: "IDLE" }
  | { kind: "LOADING" }
  | { kind: "RESULTS"; response: MemberGuestCandidateResponse; mode: "EMAIL" | "NAME" }
  | { kind: "RATE_LIMITED" }
  | { kind: "ERROR" };

export function MemberGuestFindPanel({
  openSearchEnabled,
  existingMemberIds,
  atCapacity,
  onAdd,
  onCancel,
  addError,
}: MemberGuestFindPanelProps) {
  const [text, setText] = useState("");
  const [state, setState] = useState<PanelState>({ kind: "IDLE" });
  const [selected, setSelected] = useState<MemberGuestCandidate | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputId = useId();
  const listboxId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // One controller per keystroke, aborted by the next — mirrors
  // address-autocomplete.tsx, and it is what stops a slow early request landing
  // on top of a fast later one and showing results for a query the member has
  // already typed past.
  const abortRef = useRef<AbortController | null>(null);

  const intent = classifyMemberGuestFindInput(text);
  const isEmailIntent = intent.kind === "EMAIL";

  async function runEmailResolve(email: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: "LOADING" });
    try {
      const res = await fetch("/api/members/guest-candidates/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        setState({ kind: "RATE_LIMITED" });
        return;
      }
      if (!res.ok) {
        // Includes the module-off 404. There is nothing useful to say and
        // nothing safe to infer, so it reads as the ordinary failure it is.
        setState({ kind: "ERROR" });
        return;
      }
      const response = (await res.json()) as MemberGuestCandidateResponse;
      setState({ kind: "RESULTS", response, mode: "EMAIL" });
      if (shouldAutoResolveMemberGuestCandidate(response)) {
        setSelected(response.candidates[0]!);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState({ kind: "ERROR" });
    }
  }

  // The name type-ahead. Debounced, aborted per keystroke, and only ever
  // mounted when the club turned open search on.
  useEffect(() => {
    if (!openSearchEnabled) return;
    if (selected) return;
    if (intent.kind !== "NAME") return;

    const q = intent.q;
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ kind: "LOADING" });
      fetch(`/api/members/guest-candidates/search?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (res.status === 429) {
            setState({ kind: "RATE_LIMITED" });
            return;
          }
          if (!res.ok) {
            setState({ kind: "ERROR" });
            return;
          }
          const response = (await res.json()) as MemberGuestCandidateResponse;
          setState({ kind: "RESULTS", response, mode: "NAME" });
          setActiveIndex(0);
          if (shouldAutoResolveMemberGuestCandidate(response)) {
            setSelected(response.candidates[0]!);
          }
        })
        .catch((err: Error) => {
          if (err.name === "AbortError") return;
          setState({ kind: "ERROR" });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `intent` is derived from `text`; depending on the raw string keeps the
    // effect from re-running on every render for an unchanged query.
  }, [text, openSearchEnabled, selected, intent.kind, intent.kind === "NAME" ? intent.q : ""]);

  const candidates =
    state.kind === "RESULTS" ? state.response.candidates : ([] as MemberGuestCandidate[]);
  const truncated = state.kind === "RESULTS" && state.response.truncated === true;
  const alreadyAdded = new Set(existingMemberIds);

  function chooseCandidate(candidate: MemberGuestCandidate) {
    if (alreadyAdded.has(candidate.memberId)) return;
    setSelected(candidate);
  }

  function reset() {
    setSelected(null);
    setState({ kind: "IDLE" });
    setText("");
    inputRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (selected) {
        reset();
        return;
      }
      onCancel();
      return;
    }
    if (isEmailIntent && event.key === "Enter") {
      event.preventDefault();
      submitEmail();
      return;
    }
    if (candidates.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, candidates.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const candidate = candidates[activeIndex];
      if (candidate) chooseCandidate(candidate);
    }
  }

  function submitEmail() {
    if (intent.kind !== "EMAIL") return;
    if (!intent.wellFormed) {
      // Half an address is a typing mistake, not a fact about any member, so it
      // is answered locally with the SAME sentence a real miss produces. No
      // request is made, and nothing distinguishes the two for the member.
      setState({ kind: "RESULTS", response: { candidates: [] }, mode: "EMAIL" });
      return;
    }
    void runEmailResolve(intent.email);
  }

  const label = openSearchEnabled
    ? MEMBER_GUEST_FIND_COPY.eitherLabel
    : MEMBER_GUEST_FIND_COPY.emailLabel;
  const hint = openSearchEnabled
    ? MEMBER_GUEST_FIND_COPY.eitherHint
    : MEMBER_GUEST_FIND_COPY.emailHint;

  return (
    <div className="space-y-3 rounded-lg border border-primary p-4" data-testid="member-guest-find-panel">
      {selected ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-primary bg-card px-3 py-3">
          <span className="font-semibold">
            {selected.firstName} {selected.lastName}
          </span>
          <span className="rounded-md border border-border px-2 py-0.5 text-xs font-semibold">
            {ageTierLabel(selected.ageTier)}
          </span>
          <span className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            Change
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={atCapacity || alreadyAdded.has(selected.memberId)}
            onClick={() => onAdd(selected)}
          >
            Add to booking
          </Button>
        </div>
      ) : (
        <div>
          <Label htmlFor={inputId}>{label}</Label>
          <div className="mt-1.5 flex items-end gap-2">
            <Input
              id={inputId}
              ref={inputRef}
              type="text"
              inputMode={openSearchEnabled ? "text" : "email"}
              autoComplete="off"
              value={text}
              placeholder={openSearchEnabled ? "name or email address" : "their email address"}
              onChange={(event) => {
                setText(event.target.value);
                if (!openSearchEnabled) setState({ kind: "IDLE" });
              }}
              onKeyDown={handleKeyDown}
              role={openSearchEnabled ? "combobox" : undefined}
              aria-expanded={openSearchEnabled ? candidates.length > 0 : undefined}
              aria-controls={openSearchEnabled ? listboxId : undefined}
              aria-activedescendant={
                openSearchEnabled && candidates.length > 0
                  ? `${listboxId}-option-${activeIndex}`
                  : undefined
              }
              aria-describedby={statusId}
            />
            {isEmailIntent && (
              <Button type="button" onClick={submitEmail} disabled={state.kind === "LOADING"}>
                Find
              </Button>
            )}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
        </div>
      )}

      {/* Result-count changes are announced, not only drawn: a type-ahead whose
          list silently changes under a screen reader is unusable. */}
      <p id={statusId} aria-live="polite" className="sr-only">
        {state.kind === "LOADING"
          ? "Searching"
          : selected
            ? `Selected ${selected.firstName} ${selected.lastName}`
            : candidates.length === 0
              ? ""
              : `${candidates.length} member${candidates.length === 1 ? "" : "s"} found`}
      </p>

      {state.kind === "RATE_LIMITED" && (
        <Alert variant="warning">
          <p>{MEMBER_GUEST_FIND_COPY.rateLimited}</p>
        </Alert>
      )}

      {state.kind === "ERROR" && (
        <Alert variant="warning">
          <p>{MEMBER_GUEST_FIND_COPY.networkError}</p>
        </Alert>
      )}

      {!selected && state.kind === "RESULTS" && candidates.length === 0 && (
        <div className="space-y-1.5">
          <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {state.mode === "EMAIL"
              ? MEMBER_GUEST_FIND_COPY.noEmailMatch
              : MEMBER_GUEST_FIND_COPY.noNameMatch}
          </div>
          {state.mode === "EMAIL" && (
            <p className="text-xs text-muted-foreground">
              {MEMBER_GUEST_FIND_COPY.noEmailMatchHelp}
            </p>
          )}
        </div>
      )}

      {!selected && candidates.length > 1 && (
        <div>
          {state.kind === "RESULTS" && state.mode === "EMAIL" && (
            <p className="mb-2 text-xs text-muted-foreground">
              {describeHouseholdCandidatePrompt(candidates.length)}
            </p>
          )}
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Matching members"
            className="divide-y rounded-md border border-border"
          >
            {candidates.map((candidate, index) => {
              const disabled = alreadyAdded.has(candidate.memberId);
              return (
                <li key={candidate.memberId}>
                  <button
                    type="button"
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-disabled={disabled || undefined}
                    disabled={disabled}
                    onClick={() => chooseCandidate(candidate)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${
                      index === activeIndex ? "bg-accent text-accent-foreground" : ""
                    } ${disabled ? "opacity-50" : ""}`}
                  >
                    <span className="font-medium">
                      {candidate.firstName} {candidate.lastName}
                    </span>
                    <span className="rounded-md border border-border px-2 py-0.5 text-xs font-semibold">
                      {ageTierLabel(candidate.ageTier)}
                    </span>
                    {disabled && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        Already on this booking
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {truncated && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {MEMBER_GUEST_FIND_COPY.truncated}
            </p>
          )}
          {/* Two members with the same name and the same age group render as two
              identical rows, because a row is allowed to show nothing else
              (D-19). Rather than invent a distinguisher the booker never had — a
              town, a masked email — we point them at the one fact that IS
              unambiguous and that they can go and ask for. */}
          {hasIndistinguishableMemberGuestCandidates(candidates) && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {MEMBER_GUEST_FIND_COPY.sameName}
            </p>
          )}
        </div>
      )}

      {addError && (
        <Alert variant="error">
          <p>{addError}</p>
        </Alert>
      )}

      {!selected && (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Adult" / "Child" — sentence case, as the mockup draws the row badges. */
function ageTierLabel(ageTier: string): string {
  return ageTier.charAt(0) + ageTier.slice(1).toLowerCase();
}
