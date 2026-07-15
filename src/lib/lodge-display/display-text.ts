import type { DisplayState } from "../lodge-display-state";

// Token resolution for display-authored copy (fork issue #31; value-token
// resolution inside authored HTML added in LTV-028, ADR-003 §4).
//
// The grammar is the display's OWN token set — deliberately NOT the site-wide
// token catalogue (src/lib/token-catalogue.ts), which resolves on the public
// website outside the display auth boundary. A wall must never surface a site
// token that reveals data beyond the privacy-reduced DisplayState payload, so
// PLACEHOLDER_PATTERN matches ONLY these value tokens:
//   {{config:<key>}}  {{lodge-name}}  {{display-date}}
// Any other `{{…}}` (a site token like {{club-name}}, or a `{{module:<name>}}`
// embed handled by the layout splitter) is not matched here and is therefore
// left VERBATIM — the token-scope security line lives in this closed regex.
//
// Two resolvers share that one grammar:
//   • resolveDisplayText — returns plain TEXT for React text nodes. Consumers
//     render it as children (never dangerouslySetInnerHTML), so HTML escaping
//     is React's job and a config value can never inject markup.
//   • resolveDisplayHtml — returns HTML for an authored html surface, with each
//     injected value HTML-escaped (and its braces neutralised) on injection, so
//     a config value renders as inert TEXT even inside html and can never inject
//     markup nor form a second `{{…}}` token.
//
// EXTENSION POINT (ADR-003 §4, deferred): module-contributed VALUE tokens would
// slot in here as a second alternative in PLACEHOLDER_PATTERN plus a branch in
// resolveToken — one grammar, still closed to the display's own token set. Not
// built in v1 (see #74 "Do NOT build").

const PLACEHOLDER_PATTERN = /\{\{\s*(config:([a-z0-9][a-z0-9-]{0,63})|lodge-name|display-date)\s*\}\}/gi;

/** Resolve one matched value token to its raw (unescaped) replacement string. */
function resolveToken(
  token: string,
  configKey: string | undefined,
  state: DisplayState
): string {
  const lower = token.toLowerCase();
  if (lower === "lodge-name") return state.lodge.name;
  if (lower === "display-date") {
    const day = new Date(`${state.window.start}T00:00:00`);
    return day.toLocaleDateString("en-NZ", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  }
  // configKey is always set for the remaining `config:<key>` alternative.
  const value = state.config[configKey!.toLowerCase()];
  // An unset key renders a VISIBLE placeholder so misconfiguration is obvious
  // on the screen during setup, never silently blank (brief §3).
  return value ?? `⟨config:${configKey!.toLowerCase()}?⟩`;
}

/**
 * Resolve the display's value tokens to plain TEXT (for React text nodes).
 * Non-display tokens (site catalogue tokens, module embeds) are left verbatim.
 */
export function resolveDisplayText(template: string, state: DisplayState): string {
  return template.replace(
    PLACEHOLDER_PATTERN,
    (_whole, token: string, configKey?: string) =>
      resolveToken(token, configKey, state)
  );
}

/**
 * HTML-escape a resolved value for injection into an authored html surface.
 * Escapes the five HTML-significant characters so the value renders as literal
 * text, AND neutralises `{`/`}` so an injected value can never form a second
 * `{{…}}` token (config/area/module) that a later splitter would act on — the
 * value is inert text, full stop.
 */
function escapeHtmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

// URL-scheme guard for resolved values (issue #176, ADR-003 §4). Value-token
// resolution runs AFTER the CMS sanitiser (see layout-render.ts), so the
// sanitiser's scheme allowlist never sees a resolved value: a config value like
// `javascript:alert(1)` or `data:text/html,…` resolved at the START of an
// authored `href`/`src` brings its OWN scheme past that gate. The escaping above
// stops a value BREAKING OUT of the attribute (quotes/brackets), but a scheme
// sits happily INSIDE the quotes, so escaping alone does not close this.
//
// DESIGN CHOICE — scheme check INSIDE resolution, gated on URL-attribute
// context (over a post-resolution HTML re-parse): the fix stays entirely on the
// display token path and touches only RESOLVED TOKEN VALUES. Literal authored
// URLs keep the sanitiser's own verdict (a re-parse would also have to re-decide
// them, and would wrongly strip the display's legitimately-allowed `data:` <img>
// srcs — issue #161); CMS/page-content behaviour is untouched. The check fires
// only when the token opens a URL attribute value, i.e. the resolved value is
// what determines the scheme.

/** True when the html up to `offset` ends with a URL-bearing attribute opener
 * (`href="`/`src="`), so the token that follows is the START of that URL and its
 * resolved value determines the scheme. A token AFTER a literal scheme prefix
 * (`href="https://{{config:path}}"`) does not match — the scheme is already the
 * vetted literal and the value is only a path segment. */
const URL_ATTR_OPENER = /\b(?:href|src)\s*=\s*["']?\s*$/i;
function opensUrlAttributeValue(html: string, offset: number): boolean {
  // Only the short run of text immediately before the token can hold the
  // attribute opener, so inspect a bounded tail rather than the whole prefix.
  const tail = html.slice(Math.max(0, offset - 64), offset);
  return URL_ATTR_OPENER.test(tail);
}

/** Neutralise a resolved value whose scheme is not one of the vetted URL
 * schemes. Allows http/https/mailto/tel and any relative/anchor/query reference
 * (no scheme); everything else — javascript:, data:, vbscript:, protocol-
 * relative `//host`, … — collapses to an inert `#` so the attribute stays valid
 * but dead. */
const ALLOWED_URL_SCHEME = /^(?:https?|mailto|tel)$/i;
function neutraliseUrlScheme(value: string): string {
  // Browsers ignore leading whitespace and C0 control chars when resolving a
  // URL, so trim them before inspecting the scheme (a value cannot smuggle
  // `\tjavascript:` past the check).
  const trimmed = value.replace(/^[\u0000-\u0020]+/, "");
  // Protocol-relative (`//host`) inherits the page scheme — treat it as unsafe.
  if (trimmed.startsWith("//")) return "#";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  // No scheme → a relative path or `#anchor`/`?query`: always safe.
  if (!scheme) return value;
  return ALLOWED_URL_SCHEME.test(scheme[1]) ? value : "#";
}

/**
 * Resolve the display's value tokens inside an authored html surface, with each
 * injected value HTML-escaped. The template's own markup and any non-display
 * `{{…}}` token (site catalogue tokens, `{{module:<name>}}` embeds) are left
 * untouched — only the closed value-token set is substituted, and only the
 * substituted value is escaped. Run this AFTER the CMS sanitiser (see
 * layout-render.ts): the sanitiser trusts the authored template, and escaping
 * the injected value is what keeps a config value from being markup.
 *
 * A resolved value that OPENS a URL attribute (`href="{{config:link}}"`) also
 * runs through the URL-scheme guard (issue #176) so it can never smuggle a
 * `javascript:`/`data:` scheme past the sanitiser that ran before it.
 */
export function resolveDisplayHtml(template: string, state: DisplayState): string {
  return template.replace(
    PLACEHOLDER_PATTERN,
    (_whole: string, token: string, configKey: string | undefined, offset: number, full: string) => {
      const resolved = resolveToken(token, configKey, state);
      const guarded = opensUrlAttributeValue(full, offset)
        ? neutraliseUrlScheme(resolved)
        : resolved;
      return escapeHtmlValue(guarded);
    }
  );
}
