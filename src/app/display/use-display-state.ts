"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayTemplateDefinition } from "@/lib/lodge-display/template-registry";

// Client lifecycle for the lobby display page (fork issue #32):
//
//   pairing  — no/invalid token: request a code, show it, poll claim
//   active   — render the bound template from the latest good payload
//   (stale)  — active with a stale-data flag when fetches keep failing
//
// A transient failure NEVER clears the screen (issue #32 AC5): the last good
// payload keeps rendering and a stale indicator appears past the threshold.
// A 401 (revoked/expired token) drops back to pairing within one poll (AC6).

export const DISPLAY_POLL_SECONDS = 60;
export const DISPLAY_CLAIM_POLL_SECONDS = 4;
export const DISPLAY_STALE_AFTER_MS = 3 * DISPLAY_POLL_SECONDS * 1000;

export interface DisplayPayload extends DisplayState {
  template: DisplayTemplateDefinition;
}

export type DisplayLifecycle =
  | { mode: "loading" }
  | { mode: "pairing"; code: string | null; expiresAt: string | null }
  | { mode: "active"; payload: DisplayPayload; stale: boolean };

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
      const response = await fetch("/api/display/state");
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
