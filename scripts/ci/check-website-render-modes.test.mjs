import { describe, expect, it } from "vitest";

import { auditWebsiteRenderModes } from "./check-website-render-modes.mjs";

/**
 * Unit coverage for the pure half of the public-website render-mode gate (#2352).
 * The gate itself walks the real `src/app/(website)` tree in CI; these tests pin
 * the RULES so a future edit cannot loosen them silently.
 */

const CATCH_ALL = "[...slug]/page.tsx";

const ISR_CATCH_ALL = `
export function generateStaticParams(): { slug: string[] }[] {
  return [];
}

export const revalidate = 300;

export default async function DynamicWebsitePage() {
  return null;
}
`;

const FORCE_DYNAMIC_PAGE = `
export const dynamic = "force-dynamic";

export default async function Page() {
  return null;
}
`;

function tree(overrides = {}) {
  return new Map(
    Object.entries({
      [CATCH_ALL]: ISR_CATCH_ALL,
      "page.tsx": FORCE_DYNAMIC_PAGE,
      "contact/page.tsx": FORCE_DYNAMIC_PAGE,
      "layout.tsx": "export default function Layout() { return null; }",
      ...overrides,
    }),
  );
}

describe("auditWebsiteRenderModes", () => {
  it("passes the shape #2352 slice 1 ships", () => {
    expect(auditWebsiteRenderModes(tree())).toEqual([]);
  });

  it("fails an empty scan rather than reporting success", () => {
    // A renamed route group would otherwise sail through with a green tick and
    // zero files inspected.
    const problems = auditWebsiteRenderModes(new Map());

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("must not pass on an empty scan");
  });

  it("fails a fixed route that stops declaring force-dynamic", () => {
    const problems = auditWebsiteRenderModes(
      tree({ "contact/page.tsx": "export default function Page() { return null; }" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("contact/page.tsx");
    expect(problems[0]).toContain("force-dynamic");
  });

  it("fails the catch-all if it declares force-dynamic", () => {
    const problems = auditWebsiteRenderModes(
      tree({ [CATCH_ALL]: `export const dynamic = "force-dynamic";\n${ISR_CATCH_ALL}` }),
    );

    expect(problems.some((p) => p.includes("must NOT"))).toBe(true);
  });

  it("fails the catch-all if generateStaticParams stops returning an empty list", () => {
    // Returning paths would prerender them at build, where there is no database
    // and no CSP nonce — the assertion is about the EMPTY list, not about the
    // function merely existing.
    const problems = auditWebsiteRenderModes(
      tree({
        [CATCH_ALL]: `
export function generateStaticParams(): { slug: string[] }[] {
  return [{ slug: ["about"] }];
}

export const revalidate = 300;
`,
      }),
    );

    expect(problems.some((p) => p.includes("empty array"))).toBe(true);
  });

  it("fails the catch-all if the freshness backstop is removed", () => {
    const problems = auditWebsiteRenderModes(
      tree({
        [CATCH_ALL]: `
export function generateStaticParams(): { slug: string[] }[] {
  return [];
}
`,
      }),
    );

    expect(problems.some((p) => p.includes("revalidate"))).toBe(true);
  });

  it("fails when the CMS catch-all is missing altogether", () => {
    const files = tree();
    files.delete(CATCH_ALL);

    const problems = auditWebsiteRenderModes(files);

    expect(problems.some((p) => p.includes("CMS catch-all"))).toBe(true);
  });

  it.each(["loading.tsx", "template.tsx", "default.tsx"])(
    "fails on a %s anywhere under the group",
    (filename) => {
      const problems = auditWebsiteRenderModes(
        tree({ [`contact/${filename}`]: "export default function X() { return null; }" }),
      );

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(filename);
      expect(problems[0]).toContain("boundary");
    },
  );

  it("fails on Partial Prerendering", () => {
    const problems = auditWebsiteRenderModes(
      tree({
        "contact/page.tsx": `export const experimental_ppr = true;\n${FORCE_DYNAMIC_PAGE}`,
      }),
    );

    expect(problems.some((p) => p.includes("Partial Prerendering"))).toBe(true);
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const problems = auditWebsiteRenderModes(
      tree({
        "contact/page.tsx": "export default function Page() { return null; }",
        "join/page.tsx": "export default function Page() { return null; }",
        "join/loading.tsx": "export default function Loading() { return null; }",
      }),
    );

    expect(problems).toHaveLength(3);
  });
});
