"use client";

import { useSyncExternalStore } from "react";
import { hasSignedInHint } from "@/lib/signed-in-hint";

/**
 * Reads the non-secret sign-in marker cookie (#2352 D2) in the browser.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect` on purpose: it takes
 * a separate server snapshot, so the hydration render matches the server HTML by
 * construction instead of by us remembering to seed the initial state with
 * `false`. React then re-renders with the real value.
 *
 * The server snapshot is always `false`, and that is the honest answer rather
 * than a placeholder: the layout that renders these components no longer reads the
 * session at all (that read is what forced a full render on every visit), so
 * "signed out" is what the server actually knows. On a stored ISR page it is also
 * what every visitor is served.
 *
 * Consequence, recorded rather than hidden: a signed-in member sees the
 * signed-out CTA for the frame between first paint and hydration. That flash is
 * inherent to D2 — "the header corrects itself in the browser" — and it is why the
 * two variants are rendered as one button whose text and target change, rather
 * than two buttons of different widths that would also shift the layout.
 */
function getSnapshot(): boolean {
  return hasSignedInHint(document.cookie);
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Re-reads on the two events that can change the answer without a remount:
 *  • `pageshow` — a back/forward-cache restore, which is exactly the case that
 *    matters (a member signs out, then presses Back onto a public page);
 *  • `visibilitychange` — the same tab returning to the foreground after a
 *    sign-out in another one.
 *
 * There is no cookie-change event to subscribe to, so this is a deliberate
 * "check at the moments a person could notice" rather than a live subscription.
 */
function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("pageshow", onStoreChange);
  document.addEventListener("visibilitychange", onStoreChange);

  return () => {
    window.removeEventListener("pageshow", onStoreChange);
    document.removeEventListener("visibilitychange", onStoreChange);
  };
}

export function useSignedInHint(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
