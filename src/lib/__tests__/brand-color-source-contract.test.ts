import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Recursively collect the app/component/lib source files (TS/TSX only). The
// `.css` sheet and the `__tests__` fixtures are excluded: the shims that map
// categorical hues in dark mode legitimately name the Tailwind teal utilities,
// and tests reference the literals they guard.
function listSourceFiles(path: string): string[] {
  return readdirSync(join(process.cwd(), path)).flatMap((entry) => {
    const child = join(path, entry);
    const normalized = child.replaceAll("\\", "/");
    if (statSync(join(process.cwd(), child)).isDirectory()) {
      return normalized.includes("/__tests__") ? [] : listSourceFiles(child);
    }
    return /\.tsx?$/.test(entry) ? [child] : [];
  });
}

// The ONLY file where a literal Tailwind `teal-*` utility is still allowed
// (#2137). The admin booking calendar paints each status as a SOLID swatch
// (`WAITLIST_OFFERED: bg-teal-500`) with no tinted background / accent text
// pairing, and the `--hue-*` system is defined only as such a pair — so there
// is no clean token equivalent for a standalone solid fill.
//
// Every other categorical teal (the waitlist-offered chip, the audit `family`
// badge, the family-group GROUP_CREATE badge, the dashboard Chore Roster tile)
// now reaches its hue through `CHIP_TONE_CLASSES.teal` / the `--hue-teal`
// tokens. Everything else must reach the brand accent through semantic tokens
// (`--primary`, etc.) so it follows the saved site colours.
const CATEGORICAL_TEAL_ALLOWLIST = new Set(
  ["src/components/admin-booking-calendar.tsx"].map((path) =>
    path.replaceAll("\\", "/"),
  ),
);

describe("brand accent source contract", () => {
  it("keeps the brand accent on semantic tokens, never hardcoded teal", () => {
    const brandTeal = /\b(?:bg|text|border)-teal-\d/;
    const offenders = listSourceFiles("src").filter((path) => {
      const normalized = path.replaceAll("\\", "/");
      if (CATEGORICAL_TEAL_ALLOWLIST.has(normalized)) {
        return false;
      }
      return brandTeal.test(readFileSync(join(process.cwd(), path), "utf8"));
    });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Hardcoded Tailwind teal-* utilities are the brand accent and must ` +
            `not be baked into source. Use semantic tokens (--primary, ` +
            `bg-primary/text-primary-foreground, border-primary/30, ...) so the ` +
            `admin-configured site colours apply, or the --hue-* system for a ` +
            `categorical status hue. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// The /finance surface renders inside `app-theme-scope` (see
// `src/app/(finance)/finance/layout.tsx`), which applies the club theme. Raw
// neutral utilities inside that scope ignore the theme and read wrong under
// dark mode and strongly non-default palettes — exactly the drift fixed in
// #2137. The finance tree is now 100% token-based, so this check runs with an
// EMPTY allowlist and stays cheap to keep green.
//
// Deliberately NOT repo-wide: `src/` still has ~160 files carrying raw slate
// (about 111 of them under the admin tree), so a repo-wide version would need a
// huge allowlist and would assert nothing useful. Widening it to the admin
// surface is a follow-up that has to migrate those files first.
const THEMED_TOKEN_ONLY_ROOTS = ["src/app/(finance)", "src/components/finance"];

describe("themed-surface neutral contract", () => {
  it("keeps the /finance surface on theme tokens, never raw slate or bg-white", () => {
    const rawNeutral = /\b(?:bg|text|border)-slate-\d|\bbg-white\b/;
    const offenders = THEMED_TOKEN_ONLY_ROOTS.flatMap(listSourceFiles).filter(
      (path) => rawNeutral.test(readFileSync(join(process.cwd(), path), "utf8")),
    );

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `The /finance surface renders inside app-theme-scope, so raw ` +
            `slate-*/bg-white utilities ignore the club theme and break dark ` +
            `mode. Use the semantic tokens instead: bg-card/text-card-foreground ` +
            `for card surfaces, bg-popover/text-popover-foreground for floating ` +
            `panels, text-muted-foreground for secondary labels, bg-muted for ` +
            `tinted rows, border-border for rules. Offenders:\n` +
            `${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
