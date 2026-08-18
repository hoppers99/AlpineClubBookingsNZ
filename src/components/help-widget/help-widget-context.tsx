"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type HelpQuestion,
  type HelpSection,
} from "@/lib/contextual-help/types";
import type { DiagnosticsAskRequest } from "@/lib/diagnostics/answer/contract";

/**
 * Cross-tree channel that lets a page register EXTRA help — sections and curated
 * questions — into the global help widget mounted by the layout, plus a per-page
 * HINT that reorders the widget's chip suggestions (e.g. the booking wizard step
 * a member is on). This is how the booking-detail page re-surfaces the four
 * blocks the retired `BookingHelpDialog` carried (epic #2094 C2), without the
 * widget having to know about any specific page.
 *
 * Every hook here is no-op-safe when no provider is mounted, so a page leaf can
 * register extras unconditionally and simply do nothing on surfaces (public /
 * login) that have no widget.
 */

export type HelpWidgetExtras = {
  sections?: HelpSection[];
  questions?: HelpQuestion[];
};

type Registration = { id: number; extras: HelpWidgetExtras };

/**
 * The record an operator has explicitly chosen to investigate (AID-7, #2378, owner
 * decision D11).
 *
 * IT IS AN ID AND NOTHING ELSE. No kind, no fields, no label. The kind comes from the
 * route the SERVER matches, which is what keeps "a member id sent on a booking route
 * can only ever fail to find a booking" true; the record is then re-resolved
 * server-side under the operator's own authority before a single field is read. So the
 * worst a wrong selection can do is select a record the server refuses.
 *
 * THE NONCE IS WHAT MAKES THE SECOND CLICK WORK. Choosing the same row again after
 * closing the panel must reopen it, and an id-only value would be `===` to the one
 * already held and change nothing. It counts choices, not records.
 */
export type DiagnosticsRecordSelection = { id: string; nonce: number };

/**
 * The filter state a registered admin list ACTUALLY APPLIED (#2816, owner decision
 * 13 Aug 2026: published applied state, not the raw address bar). The page
 * publishes post-parse values, defaults included — the payments activity window
 * that never reaches the URL, the bookings parse that silently dropped every
 * filter — so the model is told what the page DID, not what the address claimed.
 * The server still narrows whatever arrives to the registry row's own allowlists.
 *
 * IT IS THE WIRE SHAPE ITSELF, not a copy of it. This channel's only destination is
 * `DiagnosticsAskRequest.view`, so deriving it from the contract leaves that module
 * the ONE author of the shape, instead of a second declaration drifting silently
 * into a value the route's zod schema then rejects as a 400 the client can only
 * misreport as a network fault. The import is type-only, so nothing about the
 * contract module reaches this client bundle at runtime.
 *
 * WHAT THE COMPILER ACTUALLY CATCHES, measured rather than assumed (review,
 * 13 Aug 2026 — the earlier claim that "a field added, renamed or retyped fails to
 * compile here and at every publishing page" was mutation-proven FALSE):
 *
 *  - A field RENAMED, REMOVED or RETYPED in the contract fails to compile at every
 *    publisher that names it — but only because each publisher now assigns by name
 *    onto a `const view: DiagnosticsViewState = {}`. The three client pages used to
 *    build the object with conditional spreads inside an IIFE, which loses
 *    object-literal freshness: TypeScript then runs no excess-property check, and a
 *    renamed `status` compiled clean on `/admin/payments` while failing everywhere
 *    else. Keep the assign-by-name shape; it is the mechanism, not a style choice.
 *  - A field ADDED to the contract fails NOWHERE, here or anywhere, and no shape of
 *    publisher can change that: nothing references a field that did not exist. The
 *    drift this type prevents is the reverse direction — a publisher sending a field
 *    the contract does not have.
 */
export type DiagnosticsViewState = NonNullable<DiagnosticsAskRequest["view"]>;

type HelpWidgetContextValue = {
  /** Merged extras from every live registration (registration order). */
  extras: HelpWidgetExtras;
  /** The active page hint group, or null. */
  hintGroup: string | null;
  registerExtras: (extras: HelpWidgetExtras) => number;
  deregisterExtras: (id: number) => void;
  setHint: (group: string | null) => void;
  /** The record chosen for investigation, or null. */
  diagnosticsRecord: DiagnosticsRecordSelection | null;
  selectDiagnosticsRecord: (recordId: string) => void;
  clearDiagnosticsRecord: () => void;
  /** Whether this admin may use Diagnostics at all, published by the widget. */
  diagnosticsAvailable: boolean;
  setDiagnosticsAvailable: (available: boolean) => void;
  /** The current page's published APPLIED view state, or null (#2816). */
  diagnosticsViewState: DiagnosticsViewState | null;
  setDiagnosticsViewState: (view: DiagnosticsViewState | null) => void;
};

const HelpWidgetContext = createContext<HelpWidgetContextValue | null>(null);

/** Stable no-ops, so the provider-less hooks return the same object shape forever. */
const NOOP = () => {};
const NOOP_SELECT: (recordId: string) => void = () => {};

function mergeRegistrations(registrations: Registration[]): HelpWidgetExtras {
  const sections: HelpSection[] = [];
  const questions: HelpQuestion[] = [];
  for (const { extras } of registrations) {
    if (extras.sections) sections.push(...extras.sections);
    if (extras.questions) questions.push(...extras.questions);
  }
  return { sections, questions };
}

export function HelpWidgetProvider({ children }: { children: ReactNode }) {
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [hintGroup, setHintGroup] = useState<string | null>(null);
  const [diagnosticsRecord, setDiagnosticsRecord] =
    useState<DiagnosticsRecordSelection | null>(null);
  const [diagnosticsAvailable, setDiagnosticsAvailable] = useState(false);
  const [diagnosticsViewState, setDiagnosticsViewState] =
    useState<DiagnosticsViewState | null>(null);
  const nextId = useRef(0);
  const nextNonce = useRef(0);

  const selectDiagnosticsRecord = useCallback((recordId: string) => {
    setDiagnosticsRecord({ id: recordId, nonce: (nextNonce.current += 1) });
  }, []);

  const clearDiagnosticsRecord = useCallback(() => {
    setDiagnosticsRecord(null);
  }, []);

  const registerExtras = useCallback((extras: HelpWidgetExtras) => {
    const id = (nextId.current += 1);
    setRegistrations((prev) => [...prev, { id, extras }]);
    return id;
  }, []);

  const deregisterExtras = useCallback((id: number) => {
    setRegistrations((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const extras = useMemo(
    () => mergeRegistrations(registrations),
    [registrations],
  );

  const value = useMemo<HelpWidgetContextValue>(
    () => ({
      extras,
      hintGroup,
      registerExtras,
      deregisterExtras,
      setHint: setHintGroup,
      diagnosticsRecord,
      selectDiagnosticsRecord,
      clearDiagnosticsRecord,
      diagnosticsAvailable,
      setDiagnosticsAvailable,
      diagnosticsViewState,
      setDiagnosticsViewState,
    }),
    [
      extras,
      hintGroup,
      registerExtras,
      deregisterExtras,
      diagnosticsRecord,
      selectDiagnosticsRecord,
      clearDiagnosticsRecord,
      diagnosticsAvailable,
      diagnosticsViewState,
    ],
  );

  return (
    <HelpWidgetContext.Provider value={value}>
      {children}
    </HelpWidgetContext.Provider>
  );
}

/**
 * Read the widget's merged extras and active hint. Returns inert defaults when
 * no provider is mounted, so the widget renders fine on a bare surface.
 */
export function useHelpWidgetState(): {
  extras: HelpWidgetExtras;
  hintGroup: string | null;
} {
  const ctx = useContext(HelpWidgetContext);
  return {
    extras: ctx?.extras ?? {},
    hintGroup: ctx?.hintGroup ?? null,
  };
}

/**
 * Register page-scoped extras into the widget for as long as the calling
 * component is mounted; deregisters on unmount. No-op without a provider. The
 * extras are re-registered whenever their content changes.
 */
export function useHelpWidgetExtras(extras: HelpWidgetExtras): void {
  const ctx = useContext(HelpWidgetContext);
  const registerExtras = ctx?.registerExtras;
  const deregisterExtras = ctx?.deregisterExtras;
  // Serialise so a new object literal with identical content does not thrash the
  // registration on every render.
  const key = JSON.stringify(extras);

  useEffect(() => {
    if (!registerExtras || !deregisterExtras) {
      return;
    }
    const id = registerExtras(extras);
    return () => deregisterExtras(id);
    // `key` captures the meaningful identity of `extras`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerExtras, deregisterExtras, key]);
}

/**
 * The operator's chosen investigation record, and the two ways it changes
 * (AID-7, #2378, owner decision D11).
 *
 * WHY THIS IS NOT `useHelpWidgetExtras`. Extras register on MOUNT, which is exactly
 * wrong for a table: every row would register its own id as the page rendered, and
 * "last one wins" would silently make the bottom row of the list the subject of the
 * investigation. Choosing a record is an act by the operator, so it is a callback
 * they invoke, not a side effect of a row existing.
 *
 * Inert without a provider, so a row control can be dropped onto any surface.
 */
export function useDiagnosticsRecord(): {
  record: DiagnosticsRecordSelection | null;
  /** True only where the widget itself said this admin may use Diagnostics. */
  available: boolean;
  select: (recordId: string) => void;
  clear: () => void;
} {
  const ctx = useContext(HelpWidgetContext);
  return {
    record: ctx?.diagnosticsRecord ?? null,
    available: ctx?.diagnosticsAvailable ?? false,
    select: ctx?.selectDiagnosticsRecord ?? NOOP_SELECT,
    clear: ctx?.clearDiagnosticsRecord ?? NOOP,
  };
}

/**
 * Let the widget publish whether Diagnostics is usable at all, so a row control on a
 * page that knows nothing about permissions can hide itself.
 *
 * THE WIDGET IS THE ONE THAT KNOWS. Its `diagnostics` prop comes from the admin
 * layout, which has already resolved both halves — the operator's permission (the
 * prop's PRESENCE) and the module flag (`moduleEnabled`). Republishing it here means
 * the row control and the Diagnostics tab appear and disappear together off one
 * computation, rather than three list pages each re-deriving it and one of them
 * getting it wrong.
 */
export function usePublishDiagnosticsAvailable(available: boolean): void {
  const ctx = useContext(HelpWidgetContext);
  const publish = ctx?.setDiagnosticsAvailable;

  useEffect(() => {
    if (!publish) return;
    publish(available);
    return () => publish(false);
  }, [publish, available]);
}

/**
 * Publish the filter state this page ACTUALLY APPLIED, for AI Diagnostics (#2816).
 *
 * Call it with post-parse values, defaults included — publishing the raw address
 * would re-create exactly the divergences the owner decision rejected: a default
 * window that never reaches the URL, a malformed URL whose filters the page
 * silently dropped while still displaying them. Clears on unmount — so the next
 * page cannot inherit the last one's filters. No-op without a provider, so a page
 * renders fine on surfaces without the widget.
 *
 * `{}` AND `undefined` ARE DIFFERENT ANSWERS. `{}` is "I applied nothing", and it
 * suppresses the widget's URL fallback; `undefined` is "I publish nothing", which
 * invites it. A wired page passes an object, empty or not.
 *
 * THE DEP IS THE SERIALISED VALUE, deliberately: pages build the view object in
 * render, so an object dep would republish every render and loop through the
 * provider. Serialising means the effect re-fires only when the CONTENT changes.
 */
export function usePublishDiagnosticsViewState(
  view: DiagnosticsViewState | undefined,
): void {
  const ctx = useContext(HelpWidgetContext);
  const publish = ctx?.setDiagnosticsViewState;
  const serialised = view === undefined ? null : JSON.stringify(view);

  useEffect(() => {
    if (!publish) return;
    publish(serialised === null ? null : (JSON.parse(serialised) as DiagnosticsViewState));
    return () => publish(null);
  }, [publish, serialised]);
}

/** Read the current page's published view state, or null. Widget-side consumer. */
export function useDiagnosticsViewState(): DiagnosticsViewState | null {
  const ctx = useContext(HelpWidgetContext);
  return ctx?.diagnosticsViewState ?? null;
}

/**
 * Publish a page hint (e.g. the current booking-wizard step) that reorders the
 * widget's chips. Clears on unmount. No-op without a provider.
 */
export function useHelpWidgetHint(hint: { group?: string | null }): void {
  const ctx = useContext(HelpWidgetContext);
  const setHint = ctx?.setHint;
  const group = hint.group ?? null;

  useEffect(() => {
    if (!setHint) {
      return;
    }
    setHint(group);
    return () => setHint(null);
  }, [setHint, group]);
}
