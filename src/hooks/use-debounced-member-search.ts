"use client";

import { useEffect, useRef, useState } from "react";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

// Stable identity so the inactive state doesn't churn consumers' memos.
const NO_RESULTS: never[] = [];

/**
 * Debounced admin member search against GET /api/admin/members — the shared
 * implementation of the type-2-chars-wait-300ms-then-fetch pattern the admin
 * member area kept re-growing (#1754/#1758; member-picker,
 * family-group-editor, the member-detail Partner card, and the member-detail
 * inherit-email and parent-link searches all use it). The trimmed query must
 * reach 2 characters (and `enabled` must hold) before anything is fetched; a
 * pending fetch is discarded when the query changes or the consumer unmounts,
 * so stale responses can never overwrite newer ones. A failed search clears
 * the results and surfaces its message via `error` ("" while healthy).
 *
 * `total` is the endpoint's own count of everything the query matched, not the
 * number of rows returned: a caller passing `pageSize` can compare the two to
 * tell a page that was CUT SHORT from a complete answer, and say so (#2425).
 * That comparison is only truthful ON THE FIRST PAGE (which is all any caller
 * of this hook requests): on a later page's final partial screen `total`
 * still exceeds `results.length` although nothing was cut — a caller that
 * ever sends `page` must compare `total > page * pageSize` instead.
 * It is 0 whenever the search is inactive or failed, so `total > results.length`
 * is false in both — never a truncation hint on an empty list.
 *
 * `TMember` is the row shape the caller expects from the endpoint's `members`
 * array for its `params` (e.g. include `role`/`accessRoles` when the caller
 * post-filters on them). Post-filtering and any dropdown-open bookkeeping stay
 * with the caller — pass `onResults` to run per successful response.
 *
 * `onResponse` is the wider seam (#2264): it receives the WHOLE parsed body,
 * not just `members`, for the endpoints that answer with extra signals beside
 * the rows. The dependant-link search is the case that needs it — the server
 * reports which matches it found but could not offer and why, and whether the
 * text matched nobody at all (#2254). Neither can be inferred from the rows,
 * because the caller filters those client-side, so a caller without this seam
 * would have to either re-fetch or hand-roll the whole debounce again. The
 * payload is deliberately `unknown`: this hook makes no promise about any
 * field except `members`/`total`, so the caller narrows what it asked for.
 * Staleness rules are identical to `onResults` — it never fires for a response
 * the query has already moved past, nor after unmount.
 *
 * `active` is the same gate the returned values are derived through: true only
 * while `enabled` holds AND the trimmed query is long enough. A caller keeping
 * its own state from `onResponse` must mask it with `active`, exactly as this
 * hook masks `results`, or a closed dialog would still render the last
 * search's leftovers.
 */
export function useDebouncedMemberSearch<TMember>(options: {
  query: string;
  /**
   * The endpoint to search. Defaults to `/api/admin/members`; the only other
   * caller today is the family-group member lookup (#2568), which answers with a
   * calculated age instead of a date of birth. Any alternative must keep the
   * same response shape — a `members` array and an optional numeric `total`.
   */
  endpoint?: string;
  /** Extra query parameters sent alongside `q`. */
  params?: Readonly<Record<string, string>>;
  /** Gate beyond the length check (e.g. only while an assign panel is open). */
  enabled?: boolean;
  /** Called with each successful, non-stale response's results. */
  onResults?: (results: TMember[]) => void;
  /**
   * Called with each successful, non-stale response's FULL parsed body, for
   * endpoints that return signals alongside `members` (see the note above).
   */
  onResponse?: (payload: unknown) => void;
  /** `error` message when a failure carries no message of its own. */
  errorFallback?: string;
}): {
  results: TMember[];
  searching: boolean;
  error: string;
  total: number;
  /** True while the query is long enough and `enabled` holds. */
  active: boolean;
} {
  const {
    query,
    enabled = true,
    endpoint = "/api/admin/members",
    errorFallback = "Failed to search members",
  } = options;
  const [results, setResults] = useState<TMember[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  // Ref-held callback so an inline `onResults` doesn't retrigger the search
  // effect below (synced in its own effect: refs must not be written during
  // render, and the debounced fetch only reads it long after render).
  const onResultsRef = useRef(options.onResults);
  const onResponseRef = useRef(options.onResponse);
  useEffect(() => {
    onResultsRef.current = options.onResults;
    onResponseRef.current = options.onResponse;
  });

  // String key instead of the params object so inline `params` literals don't
  // retrigger the effect every render.
  const trimmedQuery = query.trim();
  const searchParams = new URLSearchParams(options.params ?? {});
  searchParams.set("q", trimmedQuery);
  const paramsKey = searchParams.toString();
  const active = enabled && trimmedQuery.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!active) {
      setResults([]);
      setTotal(0);
      setSearching(false);
      setError("");
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${endpoint}?${paramsKey}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || errorFallback);
        }
        if (!cancelled) {
          const members = (data.members ?? []) as TMember[];
          setResults(members);
          // Falls back to the page length rather than 0, so a response without
          // the field reads as "nothing was cut" instead of as an empty set.
          setTotal(
            typeof data.total === "number" ? data.total : members.length,
          );
          setError("");
          onResponseRef.current?.(data);
          onResultsRef.current?.(members);
        }
      } catch (err) {
        if (!cancelled) {
          setResults([]);
          setTotal(0);
          setError(err instanceof Error ? err.message : errorFallback);
        }
      } finally {
        if (!cancelled) {
          setSearching(false);
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, endpoint, paramsKey, errorFallback]);

  // Derive the inactive state at render time (the effect's own clear only
  // lands after paint): clearing the query — e.g. a picker resetting itself
  // after a selection — must not flash the previous results for a frame.
  return {
    results: active ? results : NO_RESULTS,
    searching: active ? searching : false,
    error: active ? error : "",
    total: active ? total : 0,
    active,
  };
}
