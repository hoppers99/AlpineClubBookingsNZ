import "server-only";

import type { DisplayState } from "@/lib/lodge-display-state";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { resolveDisplayHtml } from "./display-text";
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
//     CSS blocks have any `</style` sequence stripped so authored CSS cannot
//     break out of the injected <style> element.
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
 * Remove any `</style` sequence (case-insensitive) from authored CSS so it
 * cannot terminate the injected <style> element and inject markup. This is the
 * minimal guard for now; real CSS hardening (theme scoping, url()/import
 * limits, tightened img-src/font-src) is LTV-029 — see #75.
 */
export function stripStyleClose(css: string): string {
  // TODO(#75, LTV-029): full authored-CSS hardening lives here; today we only
  // neutralise the </style breakout.
  return css.replace(/<\/style/gi, "");
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
    defaultCss: stripStyleClose(input.defaultCss),
    areas: renderAreas(areas, state),
    slotContent: renderSlotContentMap(slotContent, state),
    cssOverrides: stripStyleClose(input.cssOverrides),
    footerHtml: renderAuthoredHtml(input.footerHtml, state),
  };
}
