import { describe, expect, it } from "vitest";

import { auditPublicWebsiteStructure } from "./check-website-render-modes.mjs";

/**
 * Unit coverage for the pure half of the public-website structure gate (#2352).
 * The gate itself walks the real `src/app/(website)` and `src/app/(website-dynamic)`
 * trees in CI; these tests pin the RULES so a future edit cannot loosen them
 * silently — including the ones that arrived with the owner's 3 Aug 2026 narrowing,
 * where a page in the wrong route group is a CSP decision made by accident.
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

const FIXED_NONCE_LAYOUT = `
import { WebsiteChrome } from "@/components/website/website-chrome";
import { getPublicWebsiteNonce } from "@/lib/release-nonce";

export default async function WebsiteLayout({ children }) {
  return <WebsiteChrome nonce={await getPublicWebsiteNonce()}>{children}</WebsiteChrome>;
}
`;

const PER_REQUEST_LAYOUT = `
import { headers } from "next/headers";
import { WebsiteChrome } from "@/components/website/website-chrome";
import { CSP_NONCE_HEADER } from "@/lib/csp";

export const dynamic = "force-dynamic";

export default async function DynamicWebsiteLayout({ children }) {
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;
  return <WebsiteChrome nonce={nonce}>{children}</WebsiteChrome>;
}
`;

/**
 * The shared chrome, reduced to the three properties the gate asserts: it reads
 * nothing from the request, it resolves no nonce of its own, and it passes the prop
 * through to the analytics script.
 */
const CHROME_SOURCE = `
import { AnalyticsConsent } from "@/components/analytics-consent";
import { WebsiteHeader } from "@/components/website-header";

export async function WebsiteChrome({ nonce, children }) {
  return (
    <div>
      <WebsiteHeader />
      <main>{children}</main>
      <AnalyticsConsent nonce={nonce} />
    </div>
  );
}
`;

const CENSUS_SOURCE = `
export const FIXED_NONCE_WEBSITE_ROUTES = [
  "/",
  "/[...slug]",
  "/contact",
] as const;

export const PER_REQUEST_WEBSITE_ROUTES = [
  "/hut-leader-instructions",
  "/join/[code]",
] as const;
`;

function fixedGroup(overrides = {}) {
  return new Map(
    Object.entries({
      [CATCH_ALL]: ISR_CATCH_ALL,
      "page.tsx": FORCE_DYNAMIC_PAGE,
      "contact/page.tsx": FORCE_DYNAMIC_PAGE,
      "layout.tsx": FIXED_NONCE_LAYOUT,
      ...overrides,
    }),
  );
}

function perRequestGroup(overrides = {}) {
  return new Map(
    Object.entries({
      "hut-leader-instructions/page.tsx": FORCE_DYNAMIC_PAGE,
      "join/[code]/page.tsx": FORCE_DYNAMIC_PAGE,
      "layout.tsx": PER_REQUEST_LAYOUT,
      ...overrides,
    }),
  );
}

function audit(options = {}) {
  const { fixed = {}, perRequest = {}, censusSource = CENSUS_SOURCE } = options;

  return auditPublicWebsiteStructure({
    fixedNonceFiles: fixed instanceof Map ? fixed : fixedGroup(fixed),
    perRequestFiles:
      perRequest instanceof Map ? perRequest : perRequestGroup(perRequest),
    censusSource,
    // Keyed rather than defaulted, so a case can pass `undefined` on purpose —
    // which is what `checkWorkingTree()` hands over when the file is absent, and
    // therefore the case worth covering.
    chromeSource: "chromeSource" in options ? options.chromeSource : CHROME_SOURCE,
  });
}

describe("auditPublicWebsiteStructure", () => {
  it("passes the shape the D1 narrowing ships", () => {
    expect(audit()).toEqual([]);
  });

  it("fails an empty fixed-nonce scan rather than reporting success", () => {
    // A renamed route group would otherwise sail through with a green tick and
    // zero files inspected.
    const problems = audit({ fixed: new Map() });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("must not pass on an empty scan");
  });

  it("fails an empty per-request scan, because that group vanishing is the widening", () => {
    const problems = audit({ perRequest: new Map() });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("(website-dynamic)");
    expect(problems[0]).toContain("fixed per-release nonce");
  });

  it("fails a fixed route that stops declaring force-dynamic", () => {
    const problems = audit({
      fixed: { "contact/page.tsx": "export default function Page() { return null; }" },
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("contact/page.tsx");
    expect(problems[0]).toContain("force-dynamic");
  });

  it("fails the catch-all if it declares force-dynamic", () => {
    const problems = audit({
      fixed: { [CATCH_ALL]: `export const dynamic = "force-dynamic";\n${ISR_CATCH_ALL}` },
    });

    expect(problems.some((p) => p.includes("must NOT"))).toBe(true);
  });

  it("fails the catch-all if generateStaticParams stops returning an empty list", () => {
    // Returning paths would prerender them at build, where there is no database
    // and no CSP nonce — the assertion is about the EMPTY list, not about the
    // function merely existing.
    const problems = audit({
      fixed: {
        [CATCH_ALL]: `
export function generateStaticParams(): { slug: string[] }[] {
  return [{ slug: ["about"] }];
}

export const revalidate = 300;
`,
      },
    });

    expect(problems.some((p) => p.includes("empty array"))).toBe(true);
  });

  it("fails the catch-all if the freshness backstop is removed", () => {
    const problems = audit({
      fixed: {
        [CATCH_ALL]: `
export function generateStaticParams(): { slug: string[] }[] {
  return [];
}
`,
      },
    });

    expect(problems.some((p) => p.includes("revalidate"))).toBe(true);
  });

  it("fails when the CMS catch-all is missing altogether", () => {
    const fixed = fixedGroup();
    fixed.delete(CATCH_ALL);

    expect(audit({ fixed }).some((p) => p.includes("CMS catch-all"))).toBe(true);
  });

  it.each(["loading.tsx", "template.tsx", "default.tsx"])(
    "fails on a %s anywhere under either group",
    (filename) => {
      const inFixed = audit({
        fixed: { [`contact/${filename}`]: "export default function X() { return null; }" },
      });
      const inPerRequest = audit({
        perRequest: {
          [`hut-leader-instructions/${filename}`]:
            "export default function X() { return null; }",
        },
      });

      for (const problems of [inFixed, inPerRequest]) {
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(filename);
        expect(problems[0]).toContain("boundary");
      }
    },
  );

  it("fails on Partial Prerendering in either group", () => {
    expect(
      audit({
        fixed: {
          "contact/page.tsx": `export const experimental_ppr = true;\n${FORCE_DYNAMIC_PAGE}`,
        },
      }).some((p) => p.includes("Partial Prerendering")),
    ).toBe(true);
    expect(
      audit({
        perRequest: {
          "join/[code]/page.tsx": `export const experimental_ppr = true;\n${FORCE_DYNAMIC_PAGE}`,
        },
      }).some((p) => p.includes("Partial Prerendering")),
    ).toBe(true);
  });

  describe("the per-request group can never be stored", () => {
    it("requires the group layout to declare force-dynamic", () => {
      const problems = audit({
        perRequest: { "layout.tsx": PER_REQUEST_LAYOUT.replace(/export const dynamic.*\n/, "") },
      });

      expect(problems.some((p) => p.includes("for the whole group"))).toBe(true);
    });

    it("requires each page to declare it too", () => {
      const problems = audit({
        perRequest: {
          "join/[code]/page.tsx": "export default function Page() { return null; }",
        },
      });

      expect(problems.some((p) => p.includes("as well as the group layout"))).toBe(
        true,
      );
    });

    it("refuses generateStaticParams", () => {
      const problems = audit({
        perRequest: {
          "join/[code]/page.tsx": `export function generateStaticParams() { return []; }\n${FORCE_DYNAMIC_PAGE}`,
        },
      });

      expect(problems.some((p) => p.includes("generateStaticParams"))).toBe(true);
    });

    it("refuses a revalidate export", () => {
      const problems = audit({
        perRequest: {
          "join/[code]/page.tsx": `export const revalidate = 300;\n${FORCE_DYNAMIC_PAGE}`,
        },
      });

      expect(problems.some((p) => p.includes("full-route store"))).toBe(true);
    });
  });

  describe("the route censuses", () => {
    it("fails a page added to the fixed-nonce group without amending the census", () => {
      const problems = audit({ fixed: { "trips/page.tsx": FORCE_DYNAMIC_PAGE } });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("/trips");
      expect(problems[0]).toContain("FIXED_NONCE_WEBSITE_ROUTES");
    });

    it("fails a page added to the per-request group without amending the census", () => {
      const problems = audit({
        perRequest: { "join/verify/[token]/page.tsx": FORCE_DYNAMIC_PAGE },
      });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("/join/verify/[token]");
      expect(problems[0]).toContain("PER_REQUEST_WEBSITE_ROUTES");
    });

    it("fails a census entry whose route no longer exists", () => {
      const fixed = fixedGroup();
      fixed.delete("contact/page.tsx");

      const problems = audit({ fixed });

      expect(problems.some((p) => p.includes("does not serve it"))).toBe(true);
    });

    it("fails loudly rather than vacuously when a census cannot be read", () => {
      const problems = audit({ censusSource: "export const SOMETHING_ELSE = [];" });

      expect(problems.some((p) => p.includes("pass against nothing"))).toBe(true);
    });

    it("ignores nested route groups and private folders when deriving a route", () => {
      const fixed = fixedGroup();
      fixed.delete("contact/page.tsx");
      fixed.set("(marketing)/contact/page.tsx", FORCE_DYNAMIC_PAGE);

      expect(audit({ fixed })).toEqual([]);
    });
  });

  describe("each layout's nonce source", () => {
    it("fails a fixed-nonce layout that stops using the release nonce", () => {
      const problems = audit({
        fixed: {
          "layout.tsx": FIXED_NONCE_LAYOUT.replace(
            "await getPublicWebsiteNonce()",
            '"whatever"',
          ).replace('import { getPublicWebsiteNonce } from "@/lib/release-nonce";', ""),
        },
      });

      expect(problems.some((p) => p.includes("getPublicWebsiteNonce()"))).toBe(true);
    });

    it("fails a fixed-nonce layout that reads the request", () => {
      const problems = audit({
        fixed: {
          "layout.tsx": `import { headers } from "next/headers";\n${FIXED_NONCE_LAYOUT}\nconst h = await headers();\nconst n = h.get(CSP_NONCE_HEADER);`,
        },
      });

      expect(problems.some((p) => p.includes("calls headers()"))).toBe(true);
      expect(
        problems.some((p) => p.includes("reads the per-request CSP nonce header")),
      ).toBe(true);
    });

    it("fails a per-request layout that reaches for the fixed nonce", () => {
      const problems = audit({
        perRequest: {
          "layout.tsx": `${PER_REQUEST_LAYOUT}\nconst fallback = await getPublicWebsiteNonce();`,
        },
      });

      expect(problems.some((p) => p.includes("reversed on 3 Aug 2026"))).toBe(true);
    });

    it("fails a per-request layout that stops reading the nonce header", () => {
      const problems = audit({
        perRequest: {
          "layout.tsx": PER_REQUEST_LAYOUT.replace(/CSP_NONCE_HEADER/g, "undefined"),
        },
      });

      expect(problems.some((p) => p.includes("must read the per-request CSP nonce"))).toBe(
        true,
      );
    });
  });

  describe("chrome parity", () => {
    it("fails a layout that renders public chrome of its own", () => {
      const problems = audit({
        fixed: {
          "layout.tsx": FIXED_NONCE_LAYOUT.replace(
            "{children}</WebsiteChrome>",
            "<WebsiteHeader />{children}</WebsiteChrome>",
          ),
        },
      });

      expect(problems.some((p) => p.includes("renders <WebsiteHeader> directly"))).toBe(
        true,
      );
      expect(problems.some((p) => p.includes("compose different chrome"))).toBe(true);
    });

    it("fails a layout that stops composing the shared chrome", () => {
      const problems = audit({
        perRequest: {
          "layout.tsx": PER_REQUEST_LAYOUT.replace(
            /<WebsiteChrome nonce={nonce}>{children}<\/WebsiteChrome>/,
            "<div>{children}</div>",
          ),
        },
      });

      expect(problems.some((p) => p.includes("must render <WebsiteChrome>"))).toBe(true);
    });

    /**
     * The half the extraction could otherwise have lost. While the chrome WAS
     * `(website)/layout.tsx` the request-read ban covered it; moving it to
     * `src/components/website/` moved it out of both group scans, so these cases
     * are what keep the ban real rather than a docblock claim.
     */
    it.each(["headers()", "cookies()", "auth()"])(
      "fails a shared chrome that calls %s",
      (call) => {
        const problems = audit({
          chromeSource: `${CHROME_SOURCE}\nconst x = await ${call};`,
        });

        expect(problems.some((p) => p.includes(`calls ${call}`))).toBe(true);
        expect(problems.some((p) => p.includes("BOTH public layouts"))).toBe(true);
      },
    );

    it.each(["getPublicWebsiteNonce", "CSP_NONCE_HEADER"])(
      "fails a shared chrome that resolves its own nonce via %s",
      (token) => {
        const problems = audit({
          chromeSource: CHROME_SOURCE.replace("{ nonce, children }", "{ children }")
            .replace("nonce={nonce}", `nonce={${token}}`),
        });

        expect(problems.some((p) => p.includes(token))).toBe(true);
      },
    );

    it("fails a shared chrome that stops passing the nonce prop through", () => {
      const problems = audit({
        chromeSource: CHROME_SOURCE.replace("nonce={nonce}", ""),
      });

      expect(problems.some((p) => p.includes("straight through"))).toBe(true);
    });

    it("fails a missing shared chrome rather than skipping the check", () => {
      const problems = audit({ chromeSource: undefined });

      expect(problems.some((p) => p.includes("shared chrome"))).toBe(true);
      expect(problems.some((p) => p.includes("is missing"))).toBe(true);
    });

    it("fails a layout that stops importing it from the shared module", () => {
      const problems = audit({
        fixed: {
          "layout.tsx": FIXED_NONCE_LAYOUT.replace(
            '"@/components/website/website-chrome"',
            '"./local-chrome"',
          ),
        },
      });

      expect(problems.some((p) => p.includes("no duplicated markup"))).toBe(true);
    });
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const problems = audit({
      fixed: {
        "contact/page.tsx": "export default function Page() { return null; }",
        "join/loading.tsx": "export default function Loading() { return null; }",
      },
    });

    // The missing force-dynamic, the boundary file, and the two census problems the
    // new `join/` directory creates (it serves no page, so only the boundary file
    // is reported for it).
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.some((p) => p.includes("force-dynamic"))).toBe(true);
    expect(problems.some((p) => p.includes("loading.tsx"))).toBe(true);
  });
});
