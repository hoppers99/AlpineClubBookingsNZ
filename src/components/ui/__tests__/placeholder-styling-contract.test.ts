import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #2257 (D7/D12) — "Greyed out text as Example text looks like a field is
// already filled in."
//
// Placeholder styling is HAND-COPIED across five files (four real ones plus the
// Select trigger, which had an inert copy). A grep-level contract is the only
// thing that keeps them in step: a sixth copy, or one file quietly drifting back
// to `placeholder:text-muted-foreground`, is otherwise invisible until someone
// screenshots that one screen.

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/** Every file that styles placeholder text, and how it must do it. */
const PLACEHOLDER_SITES = [
  "src/components/ui/input.tsx",
  "src/components/ui/textarea.tsx",
  "src/components/ui/command.tsx",
  "src/components/help-widget/help-free-text-input.tsx",
] as const;

describe("#2257 placeholder text never reads as content", () => {
  for (const path of PLACEHOLDER_SITES) {
    it(`${path} paints placeholders with the dedicated token and italics`, () => {
      const css = source(path);
      expect(css).toContain("placeholder:text-placeholder-foreground");
      // The italic is the load-bearing half: `--placeholder-foreground` tracks
      // `--muted-foreground`, which already sits on the WCAG 4.5:1 floor and so
      // cannot be lightened. Italics carry the "not content" signal at no
      // contrast cost.
      expect(css).toContain("placeholder:italic");
      // The muted role paints labels, captions and helper text; a placeholder
      // must not resolve through it any more, or retuning one retunes them all.
      expect(css).not.toContain("placeholder:text-muted-foreground");
    });
  }

  it("styles the Select placeholder through data-placeholder, not the inert ::placeholder", () => {
    const css = source("src/components/ui/select.tsx");
    // The trigger is a <button>. `::placeholder` exists only on <input> and
    // <textarea>, so the utility that used to sit here styled nothing at all and
    // Select placeholders rendered in full foreground ink.
    expect(css).not.toContain("placeholder:text-muted-foreground");
    expect(css).not.toContain("placeholder:text-placeholder-foreground");
    expect(css).toContain("data-[placeholder]:text-placeholder-foreground");
    expect(css).toContain("data-[placeholder]:italic");
  });

  it("declares --placeholder-foreground in every scope that restates --muted-foreground", () => {
    const globals = source("src/app/globals.css");
    // A custom property containing `var()` is substituted on the element that
    // DECLARES it and inherits as that fixed value, so a lone `:root`
    // declaration would freeze the base palette inside `.app-theme-scope`,
    // `.website-theme` and `.dark`.
    const mutedCount = globals.match(/^\s*--muted-foreground:/gm)?.length ?? 0;
    const placeholderCount =
      globals.match(/^\s*--placeholder-foreground:/gm)?.length ?? 0;
    expect(mutedCount).toBeGreaterThan(0);
    expect(placeholderCount).toBe(mutedCount);
    // Surfaced to Tailwind inline, so the utility emits `var(--placeholder-
    // foreground)` and re-resolves per scope instead of baking in `:root`'s.
    expect(globals).toContain(
      "--color-placeholder-foreground: var(--placeholder-foreground);",
    );
  });
});
