// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DISPLAY_GLOSSARY } from "@/lib/lodge-display/display-terminology";
import { listDisplayConditions } from "@/lib/lodge-display/conditions";

// #2247 (was A4). The admin used three words — Layout, Template, "board" — for
// two database rows and defined none of them. The definitions now live once in
// `display-terminology.ts` and are surfaced on the hub cards, on the Reference
// page, and in `docs/guides/display.md`.
//
// These are LIGHT pins: they check that each surface carries the SHARED
// definition, not that any surface's full copy is frozen. Reword a definition in
// one place and this fails; reword the prose around it and it does not.

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn().mockResolvedValue({ lobbyDisplay: true }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/admin/lodges")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ lodges: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          lodgeId: "lodge-default",
          lodgeName: "Silverpeak Lodge",
          conditions: listDisplayConditions().map((c) => ({
            name: c.name,
            value: false,
          })),
        }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Layout / Template / board are defined consistently (#2247)", () => {
  it("names all three words, so none of them is left undefined", () => {
    expect(DISPLAY_GLOSSARY.map((entry) => entry.term)).toEqual([
      "Layout",
      "Template",
      "Board",
    ]);
  });

  it("the Lobby Display hub cards carry the definitions", async () => {
    const { default: DisplayHubPage } = await import("../page");
    const { container } = render(await DisplayHubPage());
    const text = container.textContent ?? "";

    for (const entry of DISPLAY_GLOSSARY) {
      expect(text, `hub card missing the ${entry.term} definition`).toContain(
        entry.oneLiner
      );
    }
  });

  it("the Reference page explains Layout vs Template", async () => {
    const { default: AdminDisplayReferencePage } = await import(
      "../reference/page"
    );
    const { container } = render(<AdminDisplayReferencePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByText("Layout vs Template")).toBeDefined();
    const text = container.textContent ?? "";
    for (const entry of DISPLAY_GLOSSARY) {
      expect(
        text,
        `Reference page missing the ${entry.term} definition`
      ).toContain(entry.oneLiner);
    }
  });

  it("the operator guide quotes the same definitions", () => {
    const guide = readFileSync(
      path.join(process.cwd(), "docs/guides/display.md"),
      "utf8"
    );
    // Markdown hard-wraps, so compare on collapsed whitespace.
    const flat = guide.replace(/\s+/g, " ");
    for (const entry of DISPLAY_GLOSSARY) {
      expect(
        flat,
        `docs/guides/display.md missing the ${entry.term} definition`
      ).toContain(entry.oneLiner);
    }
  });
});
