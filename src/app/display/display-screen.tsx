"use client";

import { useEffect, useState } from "react";
import type { DisplayState } from "@/lib/lodge-display-state";
import type {
  DisplayRegionDefinition,
  DisplayTemplateDefinition,
} from "@/lib/lodge-display/template-registry";
import {
  DEFAULT_ROTATE_SECONDS,
  eligibleDisplayPanels,
} from "@/lib/lodge-display/template-registry";
import { resolveDisplayText } from "@/lib/lodge-display/display-text";
import {
  DISPLAY_MODULE_COMPONENTS,
  type DisplayModuleProps,
} from "@/components/lodge-display/modules";
import { useDisplayState, type DisplayPayload } from "./use-display-state";

// The lobby display screen (fork issue #32): full-screen, non-interactive,
// driven entirely by the display-state payload + resolved template. States:
// pairing (show the code, poll claim), active (render regions, rotate
// eligible panels), stale (keep the last good render, badge it).

function LodgeHeader({ state }: DisplayModuleProps) {
  return (
    <div className="display-lodge-header">
      <span className="display-lodge-name">{state.lodge.name}</span>
      <span className="display-lodge-date">
        {resolveDisplayText("{{display-date}}", state)}
      </span>
    </div>
  );
}

function InfoFooter({ state }: DisplayModuleProps) {
  const wifi = state.config["wifi-code"];
  const note = state.config["footer-note"];
  return (
    <div className="display-info-footer">
      {wifi && <span className="display-footer-item">Wi-Fi · {wifi}</span>}
      {note && <span className="display-footer-item">{resolveDisplayText(note, state)}</span>}
      {state.notice && <span className="display-footer-item">{state.notice}</span>}
    </div>
  );
}

// Header/footer are page furniture, delivered with the page itself; the
// booking/chore modules arrived in LTV-005/006 and notice-board in LTV-011.
const PAGE_MODULE_COMPONENTS = {
  ...DISPLAY_MODULE_COMPONENTS,
  "lodge-header": LodgeHeader,
  "info-footer": InfoFooter,
};

function Region({
  region,
  state,
}: {
  region: DisplayRegionDefinition;
  state: DisplayState;
}) {
  const panels = eligibleDisplayPanels(region, state);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (panels.length <= 1) return;
    const seconds = region.rotateSeconds ?? DEFAULT_ROTATE_SECONDS;
    const timer = setInterval(
      () => setIndex((current) => current + 1),
      seconds * 1000
    );
    return () => clearInterval(timer);
  }, [panels.length, region.rotateSeconds]);

  if (panels.length === 0) return <div className={`display-region display-region-${region.key}`} />;

  const panel = panels[index % panels.length];
  const Module =
    PAGE_MODULE_COMPONENTS[panel.module as keyof typeof PAGE_MODULE_COMPONENTS];

  return (
    <div className={`display-region display-region-${region.key}`}>
      {Module ? (
        <Module state={state} options={panel.options} />
      ) : (
        // A template referencing a module that has no renderer yet degrades
        // to a neutral placeholder — never a crash on a lobby wall.
        <div className="display-module-placeholder" data-module={panel.module} />
      )}
    </div>
  );
}

function ActiveScreen({
  payload,
  stale,
}: {
  payload: DisplayPayload;
  stale: boolean;
}) {
  const { template, ...state } = payload;
  const definition: DisplayTemplateDefinition = template;

  return (
    <div className="display-screen" data-template={definition.key}>
      {definition.regions.map((region) => (
        <Region key={region.key} region={region} state={state} />
      ))}
      {stale && <span className="display-stale-badge">Data may be out of date</span>}
    </div>
  );
}

export function DisplayScreen() {
  const lifecycle = useDisplayState();

  if (lifecycle.mode === "loading") {
    return <div className="display-shell display-loading" />;
  }

  if (lifecycle.mode === "preview-denied") {
    return (
      <div className="display-shell display-pairing">
        <span className="display-pairing-kicker">Display preview</span>
        <span className="display-pairing-help">
          Previewing the lobby display requires an administrator login in this
          browser. Sign in to the admin area, then reload this page.
        </span>
      </div>
    );
  }

  if (lifecycle.mode === "pairing") {
    return (
      <div className="display-shell display-pairing">
        <span className="display-pairing-kicker">Pair this display</span>
        {lifecycle.code ? (
          <>
            <span className="display-pairing-code">{lifecycle.code}</span>
            <span className="display-pairing-help">
              An administrator enters this code against a display device in the
              lodge admin area. It expires after 15 minutes; a fresh code
              appears automatically.
            </span>
          </>
        ) : (
          <span className="display-pairing-help">Requesting a pairing code…</span>
        )}
      </div>
    );
  }

  return (
    <div className="display-shell">
      <ActiveScreen payload={lifecycle.payload} stale={lifecycle.stale} />
    </div>
  );
}
