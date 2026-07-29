import { listDisplayCssTokens, type DisplayCssToken } from "./css-tokens";

// The display token assistant's catalogue (#2248) — the display's OWN closed
// value-token grammar (display-text.ts PLACEHOLDER_PATTERN) restated as typed
// picker entries, mirroring the *shape* of the site-wide catalogue
// (src/lib/token-catalogue.ts) without ever importing from it: a display must
// never offer a site catalogue token (see the security note at the top of
// display-text.ts).
//
// Three sources feed the picker, none of them hand-copied lists:
//  • The two standard value tokens below — the ONLY non-config alternatives in
//    PLACEHOLDER_PATTERN. Do not add entries here without extending the grammar
//    in display-text.ts first (it is deliberately closed; ADR-003 §4).
//  • The selected preview lodge's live `displayConfig` keys, fetched by the UI
//    from GET /api/admin/display/lodge-config and turned into `{{config:…}}`
//    rows via `displayConfigToken`.
//  • The theme custom properties from `listDisplayCssTokens()`, wrapped as
//    ready-to-paste `var(--…)` usages for CSS fields.
//
// Client-safe by design (pure data/string work) so the authoring UI can import
// it directly.

/** One insertable token for an authored display HTML surface. */
export interface DisplayHtmlTokenEntry {
  /** The exact text the picker inserts, e.g. `{{lodge-name}}`. */
  token: string;
  /** One-line plain-English row description. */
  description: string;
}

/**
 * The standard (non-config) value tokens — the closed set display-text.ts
 * resolves besides `{{config:<key>}}`. Locked to the grammar by
 * display-token-catalogue.test.ts, which resolves each entry through the real
 * resolver.
 */
export const DISPLAY_STANDARD_TOKENS: readonly DisplayHtmlTokenEntry[] = [
  {
    token: "{{lodge-name}}",
    description: "The name of the lodge this screen is bound to.",
  },
  {
    token: "{{display-date}}",
    description: "Today on the board — e.g. “Sunday 27 July”.",
  },
];

/**
 * The config-key slug rule, shared verbatim with the lodge-config API route
 * (which imports this constant) and behaviourally identical to the
 * `config:<key>` alternative inside display-text.ts's PLACEHOLDER_PATTERN —
 * lower-case letters/digits/hyphens, starting alphanumeric, max 64 chars.
 */
export const DISPLAY_CONFIG_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The key rule in words, for inline help and validation messages. */
export const DISPLAY_CONFIG_KEY_RULES =
  "lower-case letters, digits and hyphens only, up to 64 characters";

/** Normalise a typed config key the way the resolver matches it. */
export function normaliseDisplayConfigKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when `key` (already normalised) is a config key the grammar accepts. */
export function isValidDisplayConfigKey(key: string): boolean {
  return DISPLAY_CONFIG_KEY_PATTERN.test(key);
}

/** The insertable `{{config:<key>}}` token for a (normalised, valid) key. */
export function displayConfigToken(key: string): string {
  return `{{config:${key}}}`;
}

/**
 * A best-effort valid-slug suggestion for an invalid typed key ("Wi-Fi Code!"
 * → "wi-fi-code"); empty string when nothing salvageable remains.
 */
export function suggestDisplayConfigKey(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return isValidDisplayConfigKey(slug) ? slug : "";
}

/**
 * The visible placeholder the wall renders for a `{{config:<key>}}` token with
 * no value saved (display-text.ts resolveToken — misconfiguration is shown,
 * never silently blank). Surfaced by the picker's unset-key warning so the
 * author is told the exact consequence before inserting; locked to the real
 * resolver output by display-token-catalogue.test.ts.
 */
export function unsetDisplayConfigPlaceholder(key: string): string {
  return `⟨config:${normaliseDisplayConfigKey(key)}?⟩`;
}

/** One insertable theme token for an authored display CSS surface. */
export interface DisplayCssTokenEntry extends DisplayCssToken {
  /** The ready-to-paste usage the picker inserts, e.g. `var(--display-accent)`. */
  insertText: string;
}

/**
 * The CSS-field token list: every custom property from `listDisplayCssTokens()`
 * (never hand-copied), each wrapped as the `var(--…)` usage an author actually
 * types. Order is preserved: the board's own `--display-*` palette first
 * (always defined), then the club theme tokens.
 */
export function listDisplayCssInsertTokens(): DisplayCssTokenEntry[] {
  return listDisplayCssTokens().map((token) => ({
    ...token,
    insertText: `var(${token.name})`,
  }));
}
