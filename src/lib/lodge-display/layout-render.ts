import "server-only";

import { sanitizePageContentHtml } from "@/lib/page-content-html";
import {
  validateDisplayLayoutDefinition,
  validateDisplaySlotContent,
  type DisplayAreaDefinition,
  type DisplaySlotContentMap,
  type LayoutRenderPayload,
  type SlotContent,
} from "./layout-registry";

// Server-side assembly of a v2 Layout + Template into the display-state
// `layoutRender` payload (ADR-003 §4, LTV-027). This is where the CMS trust
// model is applied at SERVE time: every admin-authored HTML field (the layout
// body, each authored slot's html, and the footer) passes through the website
// content sanitiser, and the CSS blocks have any `</style` sequence stripped so
// authored CSS cannot break out of the injected <style> element. A validation
// or sanitise failure throws — the caller drops back to the legacy code
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

/** Sanitise the HTML fields inside one slot's content (module embeds carry no
 * HTML — only their scalar options, already validated — so pass through). */
function sanitiseSlotContent(content: SlotContent): SlotContent {
  if ("module" in content) return content;
  return { html: sanitizePageContentHtml(content.html) };
}

function sanitiseAreas(areas: DisplayAreaDefinition[]): DisplayAreaDefinition[] {
  return areas.map((area) =>
    area.defaultContent
      ? { ...area, defaultContent: sanitiseSlotContent(area.defaultContent) }
      : area
  );
}

function sanitiseSlotContentMap(
  slotContent: DisplaySlotContentMap
): DisplaySlotContentMap {
  const out: DisplaySlotContentMap = {};
  for (const [key, value] of Object.entries(slotContent)) {
    out[key] = sanitiseSlotContent(value);
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
 * Validate + sanitise a stored Layout/Template pair into the render payload.
 * Throws on any structural/validation failure so the caller can fall back to a
 * known-good legacy template rather than ever serving a broken payload.
 */
export function buildLayoutRender(input: LayoutRenderInput): LayoutRenderPayload {
  const areas = validateDisplayLayoutDefinition(input.bodyHtml, input.areas);
  const slotContent = validateDisplaySlotContent(areas, input.slotContent);

  return {
    // Sanitise the body AFTER validation — placeholders survive sanitisation
    // (they carry no angle brackets), so the client splits on the same keys.
    bodyHtml: sanitizePageContentHtml(input.bodyHtml),
    defaultCss: stripStyleClose(input.defaultCss),
    areas: sanitiseAreas(areas),
    slotContent: sanitiseSlotContentMap(slotContent),
    cssOverrides: stripStyleClose(input.cssOverrides),
    footerHtml: sanitizePageContentHtml(input.footerHtml),
  };
}
