"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayTemplateDefinition } from "@/lib/lodge-display/template-registry";
import type { LayoutRenderPayload } from "@/lib/lodge-display/layout-registry";

// Client lifecycle for the lobby display page (fork issues #32/#52):
//
//   pairing        — no/invalid token: request a code, show it, poll claim
//   active         — render the bound template from the latest good payload
//   (stale)        — active with a stale-data flag when fetches keep failing
//   preview-denied — ?preview/?previewDevice present but the caller is not a
//                    signed-in full admin (the kiosk-preview pattern, #52)
//
// PREVIEW MODE (?previewDevice=<id> or ?preview=1): the query string is
// forwarded to the state API, which honours it only for a full admin; the
// pairing flow never starts, and no banner is shown (owner's call — the
// preview IS the real screen). A transient failure NEVER clears the screen
// (issue #32 AC5); a 401 on a real device drops back to pairing within one
// poll (AC6).

export const DISPLAY_POLL_SECONDS = 60;
export const DISPLAY_CLAIM_POLL_SECONDS = 4;
export const DISPLAY_STALE_AFTER_MS = 3 * DISPLAY_POLL_SECONDS * 1000;

export interface DisplayPayload extends DisplayState {
  /** Legacy code-built-in template — always present as the safe fallback. */
  template: DisplayTemplateDefinition;
  /** Present only for a device bound to a v2 Layout+Template (LTV-027): the
   * server-sanitised layout render payload. When set, the client renders the
   * layout engine instead of the legacy built-in board. */
  layoutRender?: LayoutRenderPayload;
  /** Set by the state route (LTV-030) when a device IS bound to a v2 Template
   * but that binding is broken (missing row/layout, or a validation/sanitise
   * failure): the server drops back to the legacy `template` silently, and this
   * flag lets an admin preview surface "template failed" while a real wall shows
   * nothing but the working fallback board. Never set for an unbound device. */
  layoutRenderError?: boolean;
}

export type DisplayLifecycle =
  | { mode: "loading" }
  | { mode: "pairing"; code: string | null; expiresAt: string | null }
  | { mode: "preview-denied" }
  | { mode: "active"; payload: DisplayPayload; stale: boolean };

function previewSearch(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.has("previewDevice") || params.has("preview")
    ? window.location.search
    : null;
}

export function useDisplayState(): DisplayLifecycle {
  const [lifecycle, setLifecycle] = useState<DisplayLifecycle>({ mode: "loading" });
  const lastGoodAt = useRef<number>(0);
  const payloadRef = useRef<DisplayPayload | null>(null);

  const startPairing = useCallback(async () => {
    payloadRef.current = null;
    try {
      const response = await fetch("/api/display/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { code: string; expiresAt: string };
      setLifecycle({ mode: "pairing", code: body.code, expiresAt: body.expiresAt });
    } catch {
      setLifecycle({ mode: "pairing", code: null, expiresAt: null });
    }
  }, []);

  const fetchState = useCallback(async (): Promise<"ok" | "unauthorised" | "failed"> => {
    try {
      const search = previewSearch();
      const response = await fetch(`/api/display/state${search ?? ""}`);
      if (response.status === 401) return "unauthorised";
      if (!response.ok) return "failed";
      const payload = (await response.json()) as DisplayPayload;
      payloadRef.current = payload;
      lastGoodAt.current = Date.now();
      setLifecycle({ mode: "active", payload, stale: false });
      return "ok";
    } catch {
      return "failed";
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      const result = await fetchState();
      if (cancelled) return;

      if (result === "unauthorised") {
        if (previewSearch()) {
          // Preview requests never pair — they need an admin login instead.
          setLifecycle({ mode: "preview-denied" });
          timer = setTimeout(tick, DISPLAY_POLL_SECONDS * 1000);
          return;
        }
        await startPairing();
        if (!cancelled) timer = setTimeout(claimTick, DISPLAY_CLAIM_POLL_SECONDS * 1000);
        return;
      }
      if (result === "failed" && payloadRef.current) {
        const stale = Date.now() - lastGoodAt.current > DISPLAY_STALE_AFTER_MS;
        setLifecycle({ mode: "active", payload: payloadRef.current, stale });
      }
      if (result === "failed" && !payloadRef.current) {
        // Never had a payload and the API is unreachable — keep trying from
        // the loading state rather than flashing an error at the lobby.
        setLifecycle((current) => (current.mode === "loading" ? current : current));
      }
      timer = setTimeout(tick, DISPLAY_POLL_SECONDS * 1000);
    };

    const claimTick = async () => {
      if (cancelled) return;
      try {
        const response = await fetch("/api/display/pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "claim" }),
        });
        const body = (await response.json()) as { paired?: boolean; restart?: boolean };
        if (body.paired) {
          timer = setTimeout(tick, 0);
          return;
        }
        if (body.restart) {
          await startPairing();
        }
      } catch {
        // Poll again; pairing is patient by design.
      }
      if (!cancelled) timer = setTimeout(claimTick, DISPLAY_CLAIM_POLL_SECONDS * 1000);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchState, startPairing]);

  return lifecycle;
}
