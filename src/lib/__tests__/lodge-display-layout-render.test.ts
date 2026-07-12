import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";

// buildLayoutRender pulls in page-content-html which imports `server-only`,
// throwing outside an RSC context; stub it (mirrors display-state-route.test).
vi.mock("server-only", () => ({}));

// Imported after the server-only mock is registered (below), so buildLayoutRender
// does not throw at module-eval time.
let buildLayoutRender: (typeof import("@/lib/lodge-display/layout-render"))["buildLayoutRender"];

beforeEach(async () => {
  ({ buildLayoutRender } = await import("@/lib/lodge-display/layout-render"));
});

function state(overrides: Partial<DisplayState> = {}): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: [],
    chores: [],
    rules: null,
    notice: null,
    config: {
      "wifi-code": "alpine1234",
      xss: "<img src=x onerror=alert(1)>",
    },
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
  } as DisplayState;
}

// A layout+template that exercises every authored html surface: bodyHtml,
// slot html, defaultContent html, and footerHtml.
function input(overrides: Record<string, unknown> = {}) {
  return {
    bodyHtml:
      "<h1>{{lodge-name}}</h1><p>{{config:wifi-code}} {{club-name}}</p>" +
      "{{area:main}}{{area:withdefault}}",
    defaultCss: "",
    cssOverrides: "",
    areas: [
      { key: "main", description: "Main", kind: "static" },
      {
        key: "withdefault",
        description: "Has a default",
        kind: "static",
        defaultContent: { html: "<p>Default {{config:door-pin}}</p>" },
      },
    ],
    slotContent: {
      main: { html: "<p>{{config:xss}}</p>{{module:arrivals-board}}" },
    },
    footerHtml: "<span>{{config:xss}} {{club-name}} {{module:chores-board}}</span>",
    ...overrides,
  };
}

/** Narrow a slot's content to its html (the test only fills html slots). */
function slotHtml(
  render: ReturnType<typeof buildLayoutRender>,
  key: string
): string {
  const content = render.slotContent[key];
  if (!content || "module" in content) throw new Error(`slot "${key}" is not html`);
  return content.html;
}

describe("buildLayoutRender — LTV-028 value-token resolution", () => {
  it("resolves value tokens in bodyHtml and keeps area/module tokens intact", () => {
    const render = buildLayoutRender(input(), state());
    expect(render.bodyHtml).toContain("Silverpeak Lodge");
    expect(render.bodyHtml).toContain("alpine1234");
    // Area placeholders survive for the client body splitter.
    expect(render.bodyHtml).toContain("{{area:main}}");
    // A site-catalogue token is left VERBATIM (token-scope boundary).
    expect(render.bodyHtml).toContain("{{club-name}}");
  });

  it("HTML-escapes an injected config value on every authored surface", () => {
    const render = buildLayoutRender(input(), state());
    // Slot html: the <img onerror> value is inert escaped text, not an element.
    expect(slotHtml(render, "main")).toContain("&lt;img");
    expect(slotHtml(render, "main")).not.toContain("<img");
    // Footer html: same.
    expect(render.footerHtml).toContain("&lt;img");
    expect(render.footerHtml).not.toContain("<img");
  });

  it("keeps the VISIBLE unset marker inside defaultContent html", () => {
    const render = buildLayoutRender(input(), state());
    const withdefault = render.areas.find((a) => a.key === "withdefault");
    expect(withdefault?.defaultContent).toEqual({
      html: "<p>Default ⟨config:door-pin?⟩</p>",
    });
  });

  it("passes module embed tokens through untouched for the client splitter", () => {
    const render = buildLayoutRender(input(), state());
    expect(slotHtml(render, "main")).toContain("{{module:arrivals-board}}");
    expect(render.footerHtml).toContain("{{module:chores-board}}");
  });

  it("leaves site-catalogue tokens verbatim on slot and footer surfaces", () => {
    const render = buildLayoutRender(
      input({
        slotContent: { main: { html: "<p>{{club-name}} {{lodge-capacity}}</p>" } },
      }),
      state()
    );
    expect(slotHtml(render, "main")).toContain("{{club-name}}");
    expect(slotHtml(render, "main")).toContain("{{lodge-capacity}}");
    expect(render.footerHtml).toContain("{{club-name}}");
  });

  it("still strips <script> from authored html (CMS trust model unchanged)", () => {
    const render = buildLayoutRender(
      input({
        footerHtml: "<span>Wi-Fi</span><script>evil()</script>",
      }),
      state()
    );
    expect(render.footerHtml).not.toMatch(/<script/i);
  });
});
