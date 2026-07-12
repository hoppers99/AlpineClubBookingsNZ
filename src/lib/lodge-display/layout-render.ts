import "server-only";

import type { DisplayState } from "@/lib/lodge-display-state";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { resolveDisplayHtml } from "./display-text";
import { sanitiseDisplayCss, scopeDisplayCss } from "./css-tokens";
import {
  validateDisplayLayoutDefinition,
  validateDisplaySlotContent,
  validateHtmlModuleEmbeds,
  type DisplayAreaDefinition,
  type DisplaySlotContentMap,
  type LayoutRenderPayload,
  type SlotContent,
} from "./layout-registry";

// Server-side assembly of a v2 Layout + Template into the display-state
// `layoutRender` payload (ADR-003 §4, LTV-027/LTV-028). This is where the CMS
// trust model AND display token resolution are applied at SERVE time:
//
//  1. Every admin-authored HTML field (the layout body, each authored slot's
//     html, the footer) passes through the website content sanitiser, and the
//     CSS blocks (defaultCss + cssOverrides) are hardened by sanitiseDisplayCss
//     (external url()/@import/@charset/</style/</expression/-moz-binding
//     neutralised, length-capped — ADR-003 §4, LTV-029) then scopeDisplayCss
//     (every selector prefixed with the display's authored-root scope so a
//     template can only style the editable body/footer, never the fixed header
//     clock/brand chrome). The club-theme CSS variables ship separately as the
//     non-authored, unscoped `themeCss` so `var(--brand-*)` matches the website.
//  2. AFTER sanitisation, the display's own VALUE tokens ({{config:…}},
//     {{lodge-name}}, {{display-date}}) are resolved against the bound lodge's
//     DisplayState, with each injected value HTML-escaped (see resolveDisplayHtml)
//     so a config value renders as inert text even inside html.
//
// TOKEN-SCOPE BOUNDARY (ADR-003 §4 — the security line): resolution runs over
// the display's OWN token set only, never the site-wide token catalogue
// (src/lib/token-catalogue.ts). resolveDisplayHtml's closed grammar leaves any
// other `{{…}}` verbatim — a site token like {{club-name}} is rendered as
// literal text, so a wall can never surface data beyond the privacy-reduced
// payload. `{{module:<name>}}` embed tokens are also outside the value grammar:
// they pass through sanitisation and value resolution untouched (they are plain
// text to both), and the client splitter mounts them.
//
// A validation or sanitise failure throws — the caller drops back to the legacy
// built-in template (LTV-030 formalises the full safe-fallback board; this is
// the simple safe version). Kept server-only: it imports the sanitiser, which
// is server-only.

/**
 * Harden one authored CSS field for the unattended wall (LTV-029, #75):
 * lexically neutralise the exfiltration/injection vectors, THEN scope every
 * selector to the display's authored root so it can only style the editable
 * body/footer. Order matters — scoping runs over the already-sanitised text so
 * the blocked-marker comments it inserts are never treated as selectors.
 */
function prepareAuthoredCss(css: string): string {
  return scopeDisplayCss(sanitiseDisplayCss(css));
}

/**
 * Sanitise then token-resolve one authored html surface. Order matters:
 * sanitise the AUTHORED template first (CMS trust model — strips script/handlers),
 * THEN resolve the display's value tokens escaping each injected value, so an
 * injected config value can only ever be inert text. Module embed tokens survive
 * both steps for the client splitter.
 */
function renderAuthoredHtml(html: string, state: DisplayState): string {
  return resolveDisplayHtml(sanitizePageContentHtml(html), state);
}

/** Sanitise + token-resolve the HTML fields inside one slot's content (module
 * embeds carry no HTML — only their scalar options, already validated — so pass
 * through). */
function renderSlotContent(content: SlotContent, state: DisplayState): SlotContent {
  if ("module" in content) return content;
  return { html: renderAuthoredHtml(content.html, state) };
}

function renderAreas(
  areas: DisplayAreaDefinition[],
  state: DisplayState
): DisplayAreaDefinition[] {
  return areas.map((area) =>
    area.defaultContent
      ? { ...area, defaultContent: renderSlotContent(area.defaultContent, state) }
      : area
  );
}

function renderSlotContentMap(
  slotContent: DisplaySlotContentMap,
  state: DisplayState
): DisplaySlotContentMap {
  const out: DisplaySlotContentMap = {};
  for (const [key, value] of Object.entries(slotContent)) {
    out[key] = renderSlotContent(value, state);
  }
  return out;
}

export interface LayoutRenderInput {
  bodyHtml: string;
  defaultCss: string;
  areas: unknown;
  slotContent: unknown;
  cssOverrides: string;
  footerHtml: string;
  /** The club-theme CSS variable block (`buildClubThemeCss` output) to ship as
   * the non-authored, unscoped `themeCss`. Optional so unit tests need not
   * thread a theme; the state route always supplies the live value. */
  themeCss?: string;
}

/**
 * Validate + sanitise + token-resolve a stored Layout/Template pair into the
 * render payload, against the bound lodge's DisplayState (LTV-028: value tokens
 * resolve against `state` at serve time). Throws on any structural/validation
 * failure so the caller can fall back to a known-good legacy template rather
 * than ever serving a broken payload.
 */
export function buildLayoutRender(
  input: LayoutRenderInput,
  state: DisplayState
): LayoutRenderPayload {
  const areas = validateDisplayLayoutDefinition(input.bodyHtml, input.areas);
  const slotContent = validateDisplaySlotContent(areas, input.slotContent);
  // The footer html has no slot-content validator of its own; reject typo'd or
  // unknown module embeds in it here (fail-fast, mirrors the slot path).
  validateHtmlModuleEmbeds(input.footerHtml, "footerHtml");

  return {
    // Sanitise the body AFTER validation — placeholders survive sanitisation
    // (they carry no angle brackets), so the client splits on the same keys —
    // then resolve the display's value tokens (escaped).
    bodyHtml: renderAuthoredHtml(input.bodyHtml, state),
    // Non-authored club-theme variables, unscoped so `:root { --brand-* }`
    // cascades to the whole page; injected BEFORE the authored CSS.
    themeCss: input.themeCss ?? "",
    defaultCss: prepareAuthoredCss(input.defaultCss),
    areas: renderAreas(areas, state),
    slotContent: renderSlotContentMap(slotContent, state),
    cssOverrides: prepareAuthoredCss(input.cssOverrides),
    footerHtml: renderAuthoredHtml(input.footerHtml, state),
  };
}
