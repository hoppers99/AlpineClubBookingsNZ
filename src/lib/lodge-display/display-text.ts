import type { DisplayState } from "../lodge-display-state";

// Text placeholder resolution for display-authored copy (fork issue #31):
// {{config:<key>}} values from the lodge's sanitised config glob, plus
// {{lodge-name}} and {{display-date}}. Resolution happens ONLY inside
// display-rendered text (info footer, notice board) — deliberately not the
// site-wide token catalogue/page-content matcher, which renders on the
// public website outside the display auth boundary (same call as #30).
//
// The resolver returns plain TEXT. Consumers render it as React text nodes
// (never dangerouslySetInnerHTML), so HTML escaping is React's job and a
// config value can never inject markup.

const PLACEHOLDER_PATTERN = /\{\{\s*(config:([a-z0-9][a-z0-9-]{0,63})|lodge-name|display-date)\s*\}\}/gi;

export function resolveDisplayText(
  template: string,
  state: DisplayState
): string {
  return template.replace(
    PLACEHOLDER_PATTERN,
    (whole, token: string, configKey: string | undefined) => {
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
      if (configKey) {
        const value = state.config[configKey.toLowerCase()];
        // An unset key renders a VISIBLE placeholder so misconfiguration is
        // obvious on the screen during setup, never silently blank (brief §3).
        return value ?? `⟨config:${configKey.toLowerCase()}?⟩`;
      }
      return whole;
    }
  );
}
