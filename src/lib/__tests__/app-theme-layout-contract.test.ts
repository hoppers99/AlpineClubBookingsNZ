import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("database theme app-shell contract", () => {
  it.each(["src/app/(authenticated)/layout.tsx", "src/app/(admin)/layout.tsx"])(
    "injects the sanitized ClubTheme CSS in %s",
    (path) => {
      const layout = readRepoFile(path);

      expect(layout).toContain("getWebsiteThemeRenderState()");
      expect(layout).toContain('data-site-style="club-theme"');
      expect(layout).toContain(
        "dangerouslySetInnerHTML={{ __html: theme.css }}",
      );
    },
  );

  it("maps app presentation tokens to brand variables without remapping semantic status", () => {
    const globals = readRepoFile("src/app/globals.css");
    const start = globals.indexOf(".app-theme-scope {");
    const end = globals.indexOf("/* App headings pick up", start);
    const appThemeRules = globals.slice(start, end);

    expect(appThemeRules).toContain("--primary: var(--brand-gold)");
    expect(appThemeRules).toContain("--background: var(--brand-snow)");
    expect(appThemeRules).toContain("--background: var(--brand-deep)");
    expect(appThemeRules).toContain("--font-website-body");
    expect(appThemeRules).toContain("--font-website-heading");
    expect(appThemeRules).not.toMatch(
      /--(?:success|warning|info|danger)(?:-|:)/,
    );
  });
});
