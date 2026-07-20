// @vitest-environment jsdom

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #2146 — printing a finance/admin report while the app is in dark mode used to
// produce a blank-looking PDF.
//
// The print block forces a light PRESENTATION (`background: white`, a dark body
// colour) but it does that by setting colour on an ANCESTOR. An inherited
// declaration always loses to one that matches the element directly, and
// `src/components/ui/card.tsx` puts `text-card-foreground` on every Card root —
// so under `.dark` the card text resolved to the near-white dark token and
// printed white-on-white. Piling further `!important` overrides onto the print
// block only chases each new offender.
//
// The contract instead is: PRINT NEVER SEES DARK MODE. Every rule that installs
// the dark palette is excluded from print media, so `:root`'s light values and
// the light `.app-theme-scope` block stand and every token — including ones set
// directly on a descendant — resolves light on paper.

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/**
 * Return the bodies of every `@media not print { … }` block in `css`, matched by
 * brace depth so a nested rule cannot truncate the slice.
 */
function notPrintBlocks(css: string): string[] {
  const blocks: string[] = [];
  const marker = "@media not print {";
  let from = 0;

  for (;;) {
    const start = css.indexOf(marker, from);
    if (start === -1) return blocks;

    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(css.slice(start + marker.length, index));
    from = index;
  }
}

/** Return the body of the single `@media print { … }` block. */
function printBlock(css: string): string {
  const marker = "@media print {";
  const start = css.indexOf(marker);
  expect(start, "globals.css must keep an @media print block").toBeGreaterThan(
    -1,
  );

  let depth = 0;
  let index = start + marker.length - 1;
  for (; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return css.slice(start + marker.length, index);
}

/** Remove every `@media not print { … }` block, leaving what print media sees. */
function stripNotPrintBlocks(css: string): string {
  let remaining = css;
  for (;;) {
    const marker = "@media not print {";
    const start = remaining.indexOf(marker);
    if (start === -1) return remaining;

    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < remaining.length; index += 1) {
      if (remaining[index] === "{") depth += 1;
      if (remaining[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    remaining = remaining.slice(0, start) + remaining.slice(index + 1);
  }
}

/**
 * Split `css` into `{ selector, body }` rules, descending through at-rule
 * wrappers (`@media`, `@layer`, `@theme`) so a nested rule is still reported
 * with its own selector.
 */
function topLevelRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let cursor = 0;

  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) return rules;

    let depth = 0;
    let close = open;
    for (; close < css.length; close += 1) {
      if (css[close] === "{") depth += 1;
      if (css[close] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const selector = css
      .slice(cursor, open)
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    const body = css.slice(open + 1, close);

    if (selector.startsWith("@")) {
      rules.push(...topLevelRules(body));
    } else if (selector) {
      rules.push({ selector, body });
    }
    cursor = close + 1;
  }

  return rules;
}

/**
 * True when `selector` is gated on the dark theme class.
 *
 * `:not(...)` is stripped first so an INVERSE gate (`html:not(.dark)` — the
 * kiosk light-mode remap) is not mistaken for a dark rule.
 *
 * `(` is an accepted prefix character. That matters: this project declares its
 * dark variant as `@custom-variant dark (&:is(.dark *))` (globals.css:3), so
 * every Tailwind `dark:` utility compiles to `…:is(.dark *)` — a form the
 * original `[\s,>+~]`-only prefix class skipped entirely. `:where(.dark …)` was
 * missed for the same reason.
 */
function isDarkGated(selector: string): boolean {
  const gates = selector.replaceAll(/:not\([^)]*\)/g, "");
  return /(^|[\s,>+~(])\.dark\b/.test(gates);
}

/**
 * The declarations in `body` whose value is NOT purely a `var(--token)`
 * reference.
 *
 * A `.dark`-gated rule may stay visible to print media ONLY if every value it
 * assigns is a bare `var(--token)`: those resolve through the light `:root` /
 * `.app-theme-scope` blocks on paper and therefore self-heal. That is exactly
 * what lets the token-driven neutral remap stay outside the `@media not print`
 * wrapper.
 *
 * The check is "not a token" rather than "looks like a colour" on purpose. The
 * first cut of this test probed for `oklch()/rgb()/hsl()/#hex` and therefore
 * passed three whole classes of regression:
 *   - CSS NAMED colours (`background: black`) — black on black paper;
 *   - the newer colour functions `lab()` / `lch()` / `color()`;
 *   - a rule that assigns no colour at all, such as the `outline: none` at
 *     globals.css — colourless, but it still made the same page print
 *     differently depending on the operator's theme.
 * Requiring a token makes the invariant literally true instead of approximately
 * true, and it cannot be outrun by new CSS colour syntax.
 */
function nonTokenDeclarations(body: string): string[] {
  return body
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.includes(":"))
    .filter((declaration) => {
      const value = declaration
        .slice(declaration.indexOf(":") + 1)
        // A bare `var(--token)` self-heals. A fallback form (`var(--x, #fff)`)
        // deliberately does NOT match, so it is reported.
        .replaceAll(/var\(\s*--[a-z0-9-]+\s*\)/gi, "")
        .replaceAll("!important", "")
        .trim();
      return value !== "";
    });
}

/**
 * Selectors of every `.dark`-gated rule that print media can still see and that
 * assigns something a light `:root` cannot heal. The contract is that this is
 * empty.
 */
function printReachableDarkRules(css: string): string[] {
  return topLevelRules(stripNotPrintBlocks(css))
    .filter(({ selector }) => isDarkGated(selector))
    .filter(({ body }) => nonTokenDeclarations(body).length > 0)
    .map(({ selector }) => selector.replaceAll(/\s+/g, " "));
}

describe("#2146 print always renders the light palette", () => {
  const globals = source("src/app/globals.css");
  const screenOnly = notPrintBlocks(globals).join("\n");

  it("excludes the :root-level dark token ramp from print", () => {
    // These are the tokens the light `.app-theme-scope` block does NOT restate,
    // so nothing else would pull them back to light on paper.
    expect(screenOnly).toContain(".dark {");
    for (const declaration of [
      "--foreground: oklch(0.985 0 0)",
      "--card-foreground: oklch(0.985 0 0)",
      "--danger: oklch(0.84 0.11 27)",
      "--success: oklch(0.84 0.11 150)",
      "--hue-teal: oklch(0.84 0.11 185)",
    ]) {
      expect(screenOnly).toContain(declaration);
    }
  });

  it("excludes the dark app-theme-scope token block from print", () => {
    expect(screenOnly).toContain(".dark .app-theme-scope {");
    // The specific token behind the blank PDF: Card sets `text-card-foreground`
    // directly on its own root, so this must not resolve to the light-on-white
    // brand snow when printing.
    expect(screenOnly).toContain("--card-foreground: var(--brand-snow)");
  });

  it("excludes the literal dark callout remap from print", () => {
    // Unlike the neutral remap (which is token-driven and therefore self-heals
    // once the scope tokens are light), these carry literal dark oklch values.
    for (const rule of [
      ".text-red-600",
      ".text-blue-600",
      ".bg-amber-50",
      ".bg-yellow-50",
    ]) {
      expect(screenOnly).toContain(rule);
    }
    expect(screenOnly).toContain("oklch(0.84 0.11 27)");
    expect(screenOnly).toContain("oklch(0.29 0.05 75)");
  });

  it("leaves NO dark-gated rule reachable from print media", () => {
    // The real invariant, and the one a future dark-mode rule can regress.
    //
    // Deliberately not limited to colour declarations. A `.dark`-gated rule may
    // stay visible to print ONLY if every value it assigns is a `var(--token)`
    // that the light `:root` heals; anything else — a literal colour in ANY
    // syntax, or a colourless declaration such as `outline: none` — makes the
    // same page print differently depending on the operator's theme, so it
    // belongs in `@media not print`.
    //
    // `html:not(.dark)` is the INVERSE gate (the kiosk light-mode remap), so it
    // is not a dark-palette rule and is skipped.
    const offenders = printReachableDarkRules(globals);

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These .dark-gated rules are still visible to print media and assign ` +
            `a value the light :root cannot heal. Wrap each in ` +
            `@media not print, or express its value as a var(--token). ` +
            `Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("still allows the token-driven dark remaps to stay outside the wrapper", () => {
    // Guards the widened filter against over-reach: the `.dark .app-theme-scope`
    // neutral remap is intentionally NOT wrapped (it assigns `var(--card)` /
    // `var(--foreground)` and self-heals), and must keep passing. If this ever
    // reports zero, the check has stopped seeing those rules at all and the
    // one above would be vacuously green.
    const tokenDriven = topLevelRules(stripNotPrintBlocks(globals))
      .filter(({ selector }) => isDarkGated(selector))
      .filter(({ body }) => nonTokenDeclarations(body).length === 0);

    expect(tokenDriven.length).toBeGreaterThan(0);
    expect(
      tokenDriven.some(({ selector }) =>
        // Selectors in globals.css are wrapped over several lines by the
        // formatter, so collapse whitespace before matching.
        selector.replaceAll(/\s+/g, " ").includes(".dark .app-theme-scope"),
      ),
    ).toBe(true);
  });

  it("pins color-scheme light in print so the UA cannot repaint it dark", () => {
    // next-themes writes `color-scheme` as an INLINE style on <html> when
    // `enableColorScheme` is set, and an inline style outranks any non-important
    // rule — hence the single deliberate `!important` here.
    expect(printBlock(globals)).toMatch(
      /:root\s*\{\s*color-scheme:\s*light\s*!important;\s*\}/,
    );
  });

  it("keeps the report print roots and cards on the print block", () => {
    const print = printBlock(globals);
    expect(print).toContain(".reports-print-root");
    expect(print).toContain(".reports-print-card");
    expect(print).toContain(".lodge-instructions-print-root");
  });
});

// The guard above is only as good as the two regexes it rests on, and both had
// a silent false negative. These cases pin the fixes with synthetic CSS so a
// future "tidy-up" of either regex fails loudly instead of quietly re-opening
// the hole.
describe("#2146 the print-reachability guard has no blind spots", () => {
  it("recognises the functional :is(.dark *) / :where(.dark) gate forms", () => {
    // globals.css declares `@custom-variant dark (&:is(.dark *))`, so the gate
    // routinely appears after a `(` rather than after whitespace/a combinator.
    // The original `[\s,>+~]`-only prefix class matched such a selector ONLY by
    // accident, when the compiled class name itself happened to start with
    // `.dark…` (`.dark\:bg-red-400:is(.dark *)`). Any other subject — a
    // hand-written rule, a stacked variant, an `@apply`-derived class — slipped
    // straight through. These three are all false under the old regex:
    expect(isDarkGated(".reports-print-card:is(.dark *)")).toBe(true);
    expect(isDarkGated(":where(.dark) .reports-print-card")).toBe(true);
    expect(isDarkGated(".group:hover .stat-value:is(.dark *)")).toBe(true);
    // …and the plain descendant form still matches.
    expect(isDarkGated(".dark .app-theme-scope .foo")).toBe(true);
  });

  it("still ignores the inverse html:not(.dark) gate", () => {
    // The kiosk light-mode remap is not a dark-palette rule.
    expect(isDarkGated("html:not(.dark) .kiosk-shell .bg-slate-900")).toBe(
      false,
    );
    expect(isDarkGated(".app-theme-scope .bg-card")).toBe(false);
  });

  it("flags CSS named colours, lab()/color(), and colourless declarations", () => {
    // Each of these passed the original `oklch|rgb|hsl|#hex` colour probe.
    const missedByTheOldProbe = [
      "background: black;", // a named colour — black ink on black paper
      "color: lab(20% 40 59);", // newer colour syntax
      "background-color: color(display-p3 0.1 0.1 0.1);",
      "outline: none;", // no colour at all, but still theme-dependent print
      "background: var(--card, #0b0b0b);", // fallback form is not a bare token
    ];
    for (const declaration of missedByTheOldProbe) {
      expect(
        nonTokenDeclarations(declaration),
        `"${declaration}" must be reported as un-healable`,
      ).toHaveLength(1);
    }
  });

  it("passes a rule whose every value is a bare var(--token)", () => {
    expect(
      nonTokenDeclarations(
        "background-color: var(--card); color: var(--foreground);",
      ),
    ).toEqual([]);
  });

  it("catches a regression the shipped CSS does not contain", () => {
    // End-to-end proof on synthetic CSS: an unwrapped Tailwind-shaped dark
    // utility and an unwrapped colourless dark rule are both reported, while
    // the same rules inside `@media not print` are not.
    const leaky = `
      .dark\\:bg-slate-900:is(.dark *) { background-color: oklch(0.2 0 0); }
      .dark .app-theme-scope .foo { background: black; }
      .dark .app-theme-scope .bar { outline: none; }
      .dark .app-theme-scope .ok { color: var(--foreground); }
    `;
    expect(printReachableDarkRules(leaky)).toHaveLength(3);
    expect(printReachableDarkRules(`@media not print {${leaky}}`)).toEqual([]);
  });
});

// FIX for the gap the CSS-only guard cannot see. `globals.css` is not the whole
// stylesheet: every `dark:` utility written in TSX compiles into TAILWIND'S
// generated output, never into globals.css, so no `@media not print` wrapper in
// this repo can ever reach it. A `dark:bg-slate-900` added to a report card
// would therefore reintroduce #2146 with every CSS assertion above still green.
//
// A `dark:` utility is only a hazard when it carries a LITERAL palette colour.
// Token-driven ones (`dark:bg-input/30`, `dark:checked:bg-primary`,
// `dark:bg-warning-muted`) compile to `var(--token)` and self-heal on paper for
// exactly the same reason the neutral remap does, so they are not matched.
const TAILWIND_PALETTE_FAMILIES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
].join("|");

const LITERAL_PALETTE_DARK_UTILITY = new RegExp(
  // `dark:` plus any further stacked variants (`dark:focus:`, `dark:hover:`)
  String.raw`\bdark:(?:[a-z-]+:)*` +
    // the colour-bearing utility prefixes
    String.raw`(?:text|bg|border|ring|shadow|from|to|via|outline|decoration|divide|fill|stroke|accent|caret)-` +
    // a LITERAL value: a palette family + numeric shade, or black/white
    String.raw`(?:(?:${TAILWIND_PALETTE_FAMILIES})-\d{2,3}|black|white)\b`,
  "g",
);

/** Recursively collect the `.tsx` files under `path`, skipping `__tests__`. */
function listComponentFiles(path: string): string[] {
  const root = join(process.cwd(), path);
  if (!existsSync(root)) {
    throw new Error(
      `print-light-palette-contract: source root "${path}" does not exist. ` +
        `If the tree was renamed, update PRINTABLE_SURFACE_ROOTS.`,
    );
  }
  return readdirSync(root).flatMap((entry) => {
    const child = join(path, entry);
    if (statSync(join(process.cwd(), child)).isDirectory()) {
      return child.replaceAll("\\", "/").includes("/__tests__")
        ? []
        : listComponentFiles(child);
    }
    return entry.endsWith(".tsx") ? [child.replaceAll("\\", "/")] : [];
  });
}

// Every tree whose markup can end up on paper, taken from the print roots in
// `globals.css` (`.reports-print-root`, `.reports-print-card`,
// `.lodge-instructions-print-root`) and the `window.print()` callers:
//
// - `/finance`               → (finance)/finance/layout.tsx (`reports-print-root`)
//                              + components/finance (kpi-stat-card is a print card)
// - `/admin/reports`         → admin/reports/page.tsx
// - `/admin/roster/[date]/print`
// - `/admin/induction/[id]/print`
// - `/lodge-instructions`
// - `/hut-leader-instructions` (website-theme; never gets `.dark` — see below)
// - `components/ui`          → shared primitives that render INSIDE all of the
//                              above. `ui/card.tsx` is where #2146 actually
//                              originated, so this root is not optional.
const PRINTABLE_SURFACE_ROOTS = [
  "src/app/(finance)",
  "src/components/finance",
  "src/app/(admin)/admin/reports",
  "src/app/(admin)/admin/roster",
  "src/app/(admin)/admin/induction",
  "src/app/(authenticated)/lodge-instructions",
  "src/app/(website)/hut-leader-instructions",
  "src/components/ui",
];

// Intentionally EMPTY, like `THEMED_NEUTRAL_ALLOWLIST` in
// `brand-color-source-contract.test.ts`. It exists so a future exception is a
// reviewable one-line addition with a stated reason rather than a quiet
// narrowing of the check. There is no legitimate reason to add one: a printable
// surface has no dark presentation to preserve.
const PRINTABLE_SURFACE_DARK_ALLOWLIST = new Set<string>([]);

// The files OUTSIDE the printable roots that carry a literal-palette `dark:`
// utility today, enumerated rather than assumed. Each is unreachable from print:
//
// - `components/nav-bar.tsx` — renders on `/finance` and every admin page, but
//   its root `<header>` carries `print:hidden` (nav-bar.tsx:102) and the print
//   block also hides `nav`/`aside` outright, so the sign-out item's
//   `dark:text-red-400` never reaches paper.
// - `book/_components/guests-step.tsx` — the booking wizard. No print root, no
//   `window.print()` caller, and it is not rendered by any printable route.
// - `admin/members/_components/member-bulk-membership-dialog.tsx` — a modal
//   preview on `/admin/members`; dialogs are not printed.
// - `admin/display/{builder,templates,layouts}` — the lobby-display authoring
//   screens. The display itself is a screen medium and these editors have no
//   print affordance.
//
// This list is a DRIFT GUARD, not permission: adding a file here is a claim that
// the file can never render inside a print root, and must be justified.
const NON_PRINTABLE_DARK_UTILITY_FILES = new Set(
  [
    "src/components/nav-bar.tsx",
    "src/app/(authenticated)/book/_components/guests-step.tsx",
    "src/app/(admin)/admin/members/_components/member-bulk-membership-dialog.tsx",
    "src/app/(admin)/admin/display/builder/page.tsx",
    "src/app/(admin)/admin/display/builder/display-builder.tsx",
    "src/app/(admin)/admin/display/templates/page.tsx",
    "src/app/(admin)/admin/display/layouts/page.tsx",
  ].map((path) => path.replaceAll("\\", "/")),
);

describe("#2146 no literal-palette dark: utility on a printable surface", () => {
  it("keeps every printable surface free of literal dark: colours", () => {
    const offenders = PRINTABLE_SURFACE_ROOTS.flatMap(listComponentFiles)
      .filter((path) => !PRINTABLE_SURFACE_DARK_ALLOWLIST.has(path))
      .flatMap((path) => {
        const matches =
          readFileSync(join(process.cwd(), path), "utf8").match(
            LITERAL_PALETTE_DARK_UTILITY,
          ) ?? [];
        return [...new Set(matches)].map((match) => `${path}: ${match}`);
      });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `A \`dark:\` utility carrying a LITERAL palette colour is compiled ` +
            `into Tailwind's own output, NOT globals.css, so the ` +
            `@media not print wrappers there cannot exclude it — it prints ` +
            `exactly as written and reintroduces #2146. On a printable ` +
            `surface, either drop the dark: variant or move the colour onto a ` +
            `semantic token (bg-card / text-muted-foreground / the --hue-* ` +
            `pairs), which resolves light on paper. Offenders:\n` +
            `${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("holds the known non-printable carriers to their enumerated list", () => {
    // `String.match` with a /g/ regex is used rather than `RegExp.test`: `test`
    // advances `lastIndex` on a global regex and would skip every other file.
    const carriers = listComponentFiles("src").filter(
      (path) =>
        readFileSync(join(process.cwd(), path), "utf8").match(
          LITERAL_PALETTE_DARK_UTILITY,
        ) !== null,
    );

    const unexpected = carriers.filter(
      (path) => !NON_PRINTABLE_DARK_UTILITY_FILES.has(path),
    );
    expect(
      unexpected,
      unexpected.length === 0
        ? ""
        : `New file(s) carry a literal-palette \`dark:\` utility. Confirm the ` +
            `file can never render inside a print root (see #2146), then add ` +
            `it to NON_PRINTABLE_DARK_UTILITY_FILES with the reason:\n` +
            `${unexpected.join("\n")}`,
    ).toEqual([]);

    // Stale entries are as bad as missing ones: they make the list read as
    // permission for files that no longer exist.
    const stale = [...NON_PRINTABLE_DARK_UTILITY_FILES].filter(
      (path) => !carriers.includes(path),
    );
    expect(stale, `Remove these stale entries:\n${stale.join("\n")}`).toEqual(
      [],
    );
  });
});

describe("#2146 the html2canvas PDF capture renders light", () => {
  it("strips the dark theme from the cloned capture document", async () => {
    const { forceLightPaletteInClone } = await import("@/lib/report-pdf");

    const doc = document.implementation.createHTMLDocument("capture");
    doc.documentElement.classList.add("dark");
    doc.documentElement.style.colorScheme = "dark";
    const nested = doc.createElement("div");
    nested.className = "dark nested-scope";
    doc.body.append(nested);

    forceLightPaletteInClone(doc);

    expect(doc.documentElement.classList.contains("dark")).toBe(false);
    expect(doc.documentElement.style.colorScheme).toBe("light");
    expect(nested.classList.contains("dark")).toBe(false);
    // Only the theme class is removed; unrelated classes survive.
    expect(nested.classList.contains("nested-scope")).toBe(true);
  }, 20_000);

  it("wires the light-palette clone into the html2canvas capture", () => {
    // The capture is composited onto a hard-coded white page, so a dark-mode
    // capture would be near-white ink on white — the same blank report the print
    // path produced. Asserted on the source because driving html2canvas itself
    // needs a real layout engine.
    const pdf = source("src/lib/report-pdf.ts");
    expect(pdf).toContain('backgroundColor: "#ffffff"');
    expect(pdf).toContain("onclone: forceLightPaletteInClone");
  });
});
