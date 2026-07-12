"use client";

import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import type { DisplayState } from "@/lib/lodge-display-state";
import type {
  DisplayRegionDefinition,
  DisplayTemplateDefinition,
} from "@/lib/lodge-display/template-registry";
import {
  DEFAULT_ROTATE_SECONDS,
  eligibleDisplayPanels,
} from "@/lib/lodge-display/template-registry";
import {
  splitHtmlOnModuleTokens,
  splitLayoutBody,
  type DisplayAreaDefinition,
  type LayoutRenderPayload,
  type SlotContent,
} from "@/lib/lodge-display/layout-registry";
import type { DisplayModuleName } from "@/lib/lodge-display/template-registry";
import { evaluateDisplayCondition } from "@/lib/lodge-display/conditions";
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

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Preview-mode state for the header (issue #60): whether the URL marks this
 * as an admin preview, and any active simulated date. Computed after mount so
 * the server render and first client render match (the page is force-dynamic
 * and client-hydrated). */
function readPreviewState(): { isPreview: boolean; previewDate: string | null } {
  if (typeof window === "undefined") return { isPreview: false, previewDate: null };
  const params = new URLSearchParams(window.location.search);
  const isPreview = params.has("preview") || params.has("previewDevice");
  const raw = params.get("previewDate");
  const previewDate = raw && DATE_ONLY_REGEX.test(raw) ? raw : null;
  return { isPreview, previewDate };
}

/** Human-readable label for the accessible simulating hint; falls back to the
 * raw value if it is not a real calendar date. */
function formatSimulatedDate(dateStr: string): string {
  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateStr;
  return parsed.toLocaleDateString("en-NZ", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Live clock + payload freshness for the header (issue #56). Ticks on the
 * client only; the server render shows a blank slot for one frame. In an admin
 * preview (issue #60) the date line becomes a date picker that rewrites
 * ?previewDate and reloads — a testing tool, so a full reload is fine. While a
 * previewDate is active the clock recolours amber (data-simulated) and its date
 * line shows the simulated window start instead of today; the layout never
 * shifts. */
function HeaderClock({
  generatedAt,
  windowStart,
}: {
  generatedAt: string;
  windowStart: string;
}) {
  const [now, setNow] = useState<Date | null>(null);
  const [preview, setPreview] = useState(() => ({
    isPreview: false,
    previewDate: null as string | null,
  }));
  const dateInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setNow(new Date());
    setPreview(readPreviewState());
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!now) return <div className="display-header-clock" />;
  const updated = new Date(generatedAt);
  const simulated = preview.isPreview && preview.previewDate !== null;

  const applyPreviewDate = (value: string) => {
    if (!DATE_ONLY_REGEX.test(value)) return;
    const params = new URLSearchParams(window.location.search);
    params.set("previewDate", value);
    // A testing tool: a full reload keeps the fetch/render path identical to a
    // fresh preview open.
    window.location.search = params.toString();
  };

  const openPicker = () => {
    const input = dateInputRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus();
      input.click();
    }
  };

  // The date line shows real "today" normally; when a previewDate override is
  // active it shows the simulated window start (the board's window.start),
  // keeping the header and the board in agreement without shifting layout.
  const dateSource = simulated ? new Date(`${windowStart}T00:00:00`) : now;
  const dateLine = (
    <>
      {dateSource.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" })}
      {" · "}
      <b>updated {formatClock(updated).toLowerCase()}</b>
    </>
  );

  return (
    <div
      className="display-header-clock"
      data-simulated={simulated ? "" : undefined}
    >
      <span className="display-clock-time">{formatClock(now)}</span>
      {preview.isPreview ? (
        <button
          type="button"
          className="display-clock-date display-clock-date-picker"
          onClick={openPicker}
        >
          {dateLine}
          <input
            ref={dateInputRef}
            type="date"
            className="display-simulate-input"
            defaultValue={preview.previewDate ?? ""}
            onChange={(event) => applyPreviewDate(event.target.value)}
            aria-label="Simulate a date"
          />
        </button>
      ) : (
        <span className="display-clock-date">{dateLine}</span>
      )}
      {simulated && (
        <span className="display-visually-hidden">
          Simulating {formatSimulatedDate(preview.previewDate as string)}
        </span>
      )}
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
      <HeaderClock generatedAt={state.generatedAt} windowStart={state.window.start} />
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

// ---------------------------------------------------------------------------
// Layout engine (LTV-027, ADR-003 §1/§2): renders a v2 Layout+Template. The
// fixed shell (header + editable footer) stays out of the editable body; the
// body is `bodyHtml` split on {{area:key}} placeholders, HTML segments rendered
// verbatim (already server-sanitised) and each placeholder rendering its Area.
// ---------------------------------------------------------------------------

/** The neutral, never-crash placeholder — the same graceful-degrade stance as
 * the legacy Panel path: a broken/unknown slot leaves a quiet gap on the wall,
 * not an error. */
function NeutralPlaceholder({ module }: { module?: string }) {
  return <div className="display-module-placeholder" data-module={module} />;
}

/** Mount a module referenced by a `{{module:<name>}}` embed token in authored
 * html (LTV-028). Embed tokens carry no options in v1 (module options belong to
 * `{module, options}` slot content), so none are passed. An unknown module name
 * → the neutral placeholder, exactly like an unknown area — the same
 * graceful-degrade stance the rest of the engine takes. */
function ModuleMount({ name, state }: { name: string; state: DisplayState }) {
  const Module = DISPLAY_MODULE_COMPONENTS[name as DisplayModuleName];
  if (!Module) return <NeutralPlaceholder module={name} />;
  return <Module state={state} />;
}

/** Render an authored html surface (already server-sanitised AND value-token
 * resolved at serve time — layout-render.ts) that may embed `{{module:<name>}}`
 * tokens: split on the tokens, render html fragments verbatim and mount modules
 * between them. The common no-module case renders a single node identical to the
 * pre-LTV-028 output, so non-module slots/footers are byte-for-byte unchanged. */
function AuthoredHtml({
  html,
  state,
  className,
}: {
  html: string;
  state: DisplayState;
  className?: string;
}) {
  const segments = splitHtmlOnModuleTokens(html);
  if (segments.length === 1 && segments[0].type === "html") {
    return (
      <div className={className} dangerouslySetInnerHTML={{ __html: segments[0].html }} />
    );
  }
  return (
    <div className={className}>
      {segments.map((segment, index) =>
        segment.type === "html" ? (
          segment.html ? (
            <div key={index} dangerouslySetInnerHTML={{ __html: segment.html }} />
          ) : null
        ) : (
          <ModuleMount key={index} name={segment.name} state={state} />
        )
      )}
    </div>
  );
}

/** Render one slot's content: authored HTML (already sanitised + token-resolved
 * server-side, and split here on any {{module:…}} embeds) or an embedded module.
 * An unknown module → the neutral placeholder. A missing slot (no content, no
 * default) → nothing. */
function SlotRender({
  content,
  state,
}: {
  content: SlotContent | undefined;
  state: DisplayState;
}) {
  if (!content) return null;
  if ("module" in content) {
    const Module = DISPLAY_MODULE_COMPONENTS[content.module];
    if (!Module) return <NeutralPlaceholder module={content.module} />;
    return <Module state={state} options={content.options} />;
  }
  return <AuthoredHtml html={content.html} state={state} />;
}

/** A rotator area: cycle only among children whose condition currently holds,
 * on the area's rotateSeconds timer — the same pattern as the legacy Region.
 * Zero eligible children renders nothing. */
function RotatorArea({
  area,
  slotContent,
  state,
}: {
  area: DisplayAreaDefinition;
  slotContent: LayoutRenderPayload["slotContent"];
  state: DisplayState;
}) {
  const eligible = (area.children ?? []).filter((child) =>
    evaluateDisplayCondition(child.condition ?? "always", state)
  );
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (eligible.length <= 1) return;
    const seconds = area.rotateSeconds ?? DEFAULT_ROTATE_SECONDS;
    const timer = setInterval(
      () => setIndex((current) => current + 1),
      seconds * 1000
    );
    return () => clearInterval(timer);
  }, [eligible.length, area.rotateSeconds]);

  if (eligible.length === 0) return null;
  const child = eligible[index % eligible.length];
  return (
    <SlotRender content={slotContent[`${area.key}/${child.key}`]} state={state} />
  );
}

/** One named area: static (always), conditional (only while its condition
 * holds), or rotator (cycles its eligible children). */
function Area({
  area,
  slotContent,
  state,
}: {
  area: DisplayAreaDefinition | undefined;
  slotContent: LayoutRenderPayload["slotContent"];
  state: DisplayState;
}) {
  // Server validation guarantees every placeholder has an area; stay defensive
  // for the unattended wall regardless.
  if (!area) return <NeutralPlaceholder />;
  if (area.kind === "rotator") {
    return <RotatorArea area={area} slotContent={slotContent} state={state} />;
  }
  if (area.kind === "conditional") {
    if (!evaluateDisplayCondition(area.condition ?? "always", state)) return null;
  }
  const content = slotContent[area.key] ?? area.defaultContent;
  return <SlotRender content={content} state={state} />;
}

/** Render boundary around each body segment: a throwing module/area drops to
 * the neutral placeholder instead of blanking the whole wall (LTV-030 hardens
 * this further). */
class AreaErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <NeutralPlaceholder />;
    return this.props.children;
  }
}

function LayoutScreen({
  payload,
  stale,
}: {
  payload: DisplayPayload & { layoutRender: LayoutRenderPayload };
  stale: boolean;
}) {
  // Strip layoutRender; the rest (incl. the legacy `template` fallback field)
  // is a superset of DisplayState and safe to pass to the shell/modules.
  const { layoutRender, ...state } = payload;
  const segments = splitLayoutBody(layoutRender.bodyHtml);
  const areasByKey = new Map(layoutRender.areas.map((area) => [area.key, area]));

  return (
    <div className="display-screen display-layout-screen">
      {/* Server already stripped `</style`; scoping/theming is #75's job. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `${layoutRender.defaultCss}\n${layoutRender.cssOverrides}`,
        }}
      />
      <LodgeHeader state={state} />
      <div className="display-layout-body">
        {segments.map((segment, segmentIndex) =>
          segment.type === "html" ? (
            <div
              key={segmentIndex}
              dangerouslySetInnerHTML={{ __html: segment.html }}
            />
          ) : (
            <AreaErrorBoundary key={segmentIndex}>
              <Area
                area={areasByKey.get(segment.key)}
                slotContent={layoutRender.slotContent}
                state={state}
              />
            </AreaErrorBoundary>
          )
        )}
      </div>
      {layoutRender.footerHtml ? (
        <AuthoredHtml
          html={layoutRender.footerHtml}
          state={state}
          className="display-info-footer"
        />
      ) : (
        <InfoFooter state={state} />
      )}
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

  // A v2 layout render wins when present (device bound to a Layout+Template);
  // otherwise the legacy built-in board path renders unchanged (LTV-038 retires
  // it). Walls on built-ins keep working exactly as before.
  const { payload, stale } = lifecycle;
  return (
    <div className="display-shell">
      {payload.layoutRender ? (
        <LayoutScreen
          payload={{ ...payload, layoutRender: payload.layoutRender }}
          stale={stale}
        />
      ) : (
        <ActiveScreen payload={payload} stale={stale} />
      )}
    </div>
  );
}
