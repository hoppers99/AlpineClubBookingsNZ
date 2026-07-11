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

function formatClock(date: Date): string {
  return date
    .toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })
    .toUpperCase();
}

/** Live clock + payload freshness for the header (issue #56). Ticks on the
 * client only; the server render shows a blank slot for one frame. */
function HeaderClock({ generatedAt }: { generatedAt: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!now) return <div className="display-header-clock" />;
  const updated = new Date(generatedAt);
  return (
    <div className="display-header-clock">
      <span className="display-clock-time">{formatClock(now)}</span>
      <span className="display-clock-date">
        {now.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" })}
        {" · "}
        <b>updated {formatClock(updated).toLowerCase()}</b>
      </span>
    </div>
  );
}

function LodgeHeader({ state }: DisplayModuleProps) {
  return (
    <div className="display-lodge-header">
      <div className="display-header-brand">
        {state.club.logoDataUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="display-header-logo"
            src={state.club.logoDataUrl}
            alt=""
          />
        )}
        <div>
          <div className="display-lodge-name">{state.lodge.name}</div>
          {state.club.name && (
            <div className="display-club-name">{state.club.name}</div>
          )}
        </div>
      </div>
      <HeaderClock generatedAt={state.generatedAt} />
    </div>
  );
}

function InfoFooter({ state }: DisplayModuleProps) {
  const wifiName = state.config["wifi-name"];
  const wifiCode = state.config["wifi-code"];
  const email = state.config["contact-email"];
  const note = state.config["footer-note"];
  return (
    <div className="display-info-footer">
      {wifiCode && (
        <span className="display-footer-item">
          <span className="display-footer-icon">📶</span>
          Wi-Fi {wifiName && <b>{wifiName}</b>} · <b>{wifiCode}</b>
        </span>
      )}
      {email && (
        <span className="display-footer-item">
          <span className="display-footer-icon">✉</span>
          <b>{email}</b>
        </span>
      )}
      {note && (
        <span className="display-footer-note">{resolveDisplayText(note, state)}</span>
      )}
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

function Panel({
  panel,
  state,
}: {
  panel: DisplayRegionDefinition["panels"][number];
  state: DisplayState;
}) {
  const Module =
    PAGE_MODULE_COMPONENTS[panel.module as keyof typeof PAGE_MODULE_COMPONENTS];
  if (!Module) {
    // A template referencing a module that has no renderer yet degrades
    // to a neutral placeholder — never a crash on a lobby wall.
    return <div className="display-module-placeholder" data-module={panel.module} />;
  }
  return <Module state={state} options={panel.options} />;
}

function Region({
  region,
  state,
}: {
  region: DisplayRegionDefinition;
  state: DisplayState;
}) {
  const panels = eligibleDisplayPanels(region, state);
  const rotates = region.layout !== "stack";
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!rotates || panels.length <= 1) return;
    const seconds = region.rotateSeconds ?? DEFAULT_ROTATE_SECONDS;
    const timer = setInterval(
      () => setIndex((current) => current + 1),
      seconds * 1000
    );
    return () => clearInterval(timer);
  }, [rotates, panels.length, region.rotateSeconds]);

  if (panels.length === 0) return <div className={`display-region display-region-${region.key}`} />;

  // "stack" (issue #56): every eligible panel at once — the sidebar-card
  // treatment; "rotate" (default): one panel at a time on the region timer.
  if (!rotates) {
    return (
      <div className={`display-region display-region-${region.key} display-region-stack`}>
        {panels.map((panel, panelIndex) => (
          <Panel key={`${panel.module}-${panelIndex}`} panel={panel} state={state} />
        ))}
      </div>
    );
  }

  const panel = panels[index % panels.length];
  return (
    <div className={`display-region display-region-${region.key}`}>
      <Panel panel={panel} state={state} />
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
