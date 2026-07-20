// @vitest-environment jsdom

import { readFileSync } from "node:fs";
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

  it("leaves no LITERAL dark colour reachable from print media", () => {
    // The real invariant, and the one a future dark-mode rule can regress.
    //
    // A `.dark`-gated rule may stay visible to print ONLY if every value it
    // assigns is a `var(--token)` — those resolve through the light `:root` /
    // `.app-theme-scope` blocks on paper and therefore self-heal (this is what
    // lets the token-driven neutral remap stay outside the wrapper). A literal
    // `oklch(...)` / `#hex` / `rgb(...)` cannot self-heal and must be wrapped in
    // `@media not print`.
    //
    // `html:not(.dark)` is the INVERSE gate (the kiosk light-mode remap), so it
    // is not a dark-palette rule and is skipped.
    const offenders = topLevelRules(stripNotPrintBlocks(globals))
      .filter(({ selector }) => {
        const gates = selector.replaceAll(/:not\([^)]*\)/g, "");
        return /(^|[\s,>+~])\.dark\b/.test(gates);
      })
      .filter(({ body }) =>
        /(oklch|rgba?|hsla?)\(|#[0-9a-f]{3,8}\b/i.test(
          // Ignore comment prose, which quotes example values.
          body.replaceAll(/\/\*[\s\S]*?\*\//g, ""),
        ),
      )
      .map(({ selector }) => selector);

    expect(offenders).toEqual([]);
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
