import { describe, expect, it } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";

// Issue #29 (LTV-004, ADR-002) + LTV-024: the template registry and condition
// engine — built-in resolution (DB overrides retired with the v2 rebuild),
// load-time rejection of unknown modules/conditions (never a partially-broken
// template), pure condition evaluation, and eligibility filtering for rotation.

function stateWith(overrides: Partial<DisplayState>): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: [
      { date: "2026-04-13", arriving: 0, departing: 0, staying: 0 },
      { date: "2026-04-14", arriving: 0, departing: 0, staying: 0 },
      { date: "2026-04-15", arriving: 0, departing: 0, staying: 0 },
    ],
    chores: [],
    rules: null,
    notice: null,
    config: {},
    ...overrides,
  };
}

describe("condition engine (pure functions of DisplayState)", () => {
  it("evaluates each named v1 condition", async () => {
    const { evaluateDisplayCondition } = await import(
      "@/lib/lodge-display/conditions"
    );

    const empty = stateWith({});
    expect(evaluateDisplayCondition("always", empty)).toBe(true);
    expect(evaluateDisplayCondition("no-guests", empty)).toBe(true);
    expect(evaluateDisplayCondition("arrivals-today", empty)).toBe(false);
    expect(evaluateDisplayCondition("whole-lodge-booking-in-window", empty)).toBe(false);

    const busy = stateWith({
      bookings: [
        {
          key: "row-1-0",
          label: "Harakeke College",
          wholeLodge: true,
          roomId: null,
          guests: null,
          guestCount: 14,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15",
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 14, departing: 0, staying: 14 },
        { date: "2026-04-14", arriving: 0, departing: 0, staying: 14 },
        { date: "2026-04-15", arriving: 0, departing: 14, staying: 14 },
      ],
    });
    expect(evaluateDisplayCondition("whole-lodge-booking-in-window", busy)).toBe(true);
    expect(evaluateDisplayCondition("arrivals-today", busy)).toBe(true);
    expect(evaluateDisplayCondition("no-guests", busy)).toBe(false);
  });
});

describe("template validation (AC6/AC7)", () => {
  it("rejects unknown modules and unknown conditions with descriptive errors", async () => {
    const { validateDisplayTemplateDefinition } = await import(
      "@/lib/lodge-display/template-registry"
    );

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "bad-module",
        name: "Bad",
        regions: [{ key: "main", panels: [{ module: "crypto-miner" }] }],
      })
    ).toThrow(/unknown module "crypto-miner"/);

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "bad-condition",
        name: "Bad",
        regions: [
          { key: "main", panels: [{ module: "welcome", condition: "if(true)" }] },
        ],
      })
    ).toThrow(/unknown condition "if\(true\)"/);
  });

  it("rejects non-scalar options, duplicate regions, and empty structures", async () => {
    const { validateDisplayTemplateDefinition } = await import(
      "@/lib/lodge-display/template-registry"
    );

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "bad-options",
        name: "Bad",
        regions: [
          {
            key: "main",
            panels: [{ module: "welcome", options: { nested: { evil: true } } }],
          },
        ],
      })
    ).toThrow(/must be a scalar/);

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "dupe-regions",
        name: "Bad",
        regions: [
          { key: "main", panels: [{ module: "welcome" }] },
          { key: "main", panels: [{ module: "welcome" }] },
        ],
      })
    ).toThrow(/duplicate region key/);

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "no-regions",
        name: "Bad",
        regions: [],
      })
    ).toThrow(/at least one region/);
  });

  it("accepts the stack layout and rejects unknown layouts (issue #56)", async () => {
    const { validateDisplayTemplateDefinition } = await import(
      "@/lib/lodge-display/template-registry"
    );

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "stacked",
        name: "Stacked",
        regions: [
          {
            key: "side",
            layout: "stack",
            panels: [{ module: "chores-board" }, { module: "lodge-rules" }],
          },
        ],
      })
    ).not.toThrow();

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "bad-layout",
        name: "Bad",
        regions: [
          { key: "side", layout: "carousel", panels: [{ module: "welcome" }] },
        ],
      })
    ).toThrow(/layout must be "rotate" or "stack"/);
  });
});

describe("registry resolution (AC1/AC2/AC3)", () => {
  it("ships the three validated starter templates", async () => {
    const { listBuiltInDisplayTemplates } = await import(
      "@/lib/lodge-display/template-registry"
    );
    const keys = listBuiltInDisplayTemplates().map((t) => t.key);
    expect(keys).toEqual(["everyday-board", "whole-lodge", "singles-house"]);
    for (const template of listBuiltInDisplayTemplates()) {
      expect(template.regions.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("resolves a built-in by key", async () => {
    const { resolveDisplayTemplate } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    const resolved = resolveDisplayTemplate("everyday-board");
    expect(resolved?.definition.name).toBe("Everyday board");
  });

  it("returns null for an unknown key", async () => {
    const { resolveDisplayTemplate } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    expect(resolveDisplayTemplate("nope")).toBeNull();
  });

  it("resolves a device to its templateKey built-in, else the club default", async () => {
    const { resolveDisplayTemplateForDevice } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    expect(
      resolveDisplayTemplateForDevice({ templateKey: "whole-lodge" }).definition
        .key
    ).toBe("whole-lodge");
    // Unknown or unset key falls back to the everyday-board default.
    expect(
      resolveDisplayTemplateForDevice({ templateKey: null }).definition.key
    ).toBe("everyday-board");
    expect(
      resolveDisplayTemplateForDevice({ templateKey: "gone" }).definition.key
    ).toBe("everyday-board");
  });
});

describe("rotation eligibility (AC4/AC5)", () => {
  it("skips panels whose condition fails and keeps eligible ones in order", async () => {
    const { eligibleDisplayPanels, listBuiltInDisplayTemplates } = await import(
      "@/lib/lodge-display/template-registry"
    );
    const wholeLodgeTemplate = listBuiltInDisplayTemplates().find(
      (t) => t.key === "whole-lodge"
    )!;
    const main = wholeLodgeTemplate.regions.find((r) => r.key === "main")!;

    // No whole-lodge booking → the blockout panel is skipped; welcome remains.
    const quiet = eligibleDisplayPanels(main, stateWith({}));
    expect(quiet.map((p) => p.module)).toEqual(["welcome"]);

    // Whole-lodge booking present → both panels rotate.
    const blockout = eligibleDisplayPanels(
      main,
      stateWith({
        bookings: [
          {
            key: "row-1-0",
            label: "Harakeke College",
            wholeLodge: true,
            roomId: null,
            guests: null,
            guestCount: 14,
            stayStart: "2026-04-13",
            stayEnd: "2026-04-15",
          },
        ],
      })
    );
    expect(blockout.map((p) => p.module)).toEqual(["occupancy-grid", "welcome"]);
  });
});
