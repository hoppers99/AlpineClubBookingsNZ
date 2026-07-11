import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";

// Issue #29 (LTV-004, ADR-002): the template registry and condition engine —
// built-in resolution vs DB overrides, load-time rejection of unknown
// modules/conditions (never a partially-broken template), pure condition
// evaluation, and eligibility filtering for rotation.

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    displayTemplate: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

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

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
});

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

  it("resolves a built-in when no DB row exists", async () => {
    const { resolveDisplayTemplate } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    const resolved = await resolveDisplayTemplate("everyday-board");
    expect(resolved?.source).toBe("built-in");
    expect(resolved?.definition.name).toBe("Everyday board");
  });

  it("prefers a DB override over the code default for the same key", async () => {
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({
      key: "everyday-board",
      source: "BUILT_IN_OVERRIDE",
      definition: {
        key: "everyday-board",
        name: "Everyday board (club edit)",
        regions: [{ key: "main", panels: [{ module: "arrivals-board" }] }],
      },
    });
    const { resolveDisplayTemplate } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    const resolved = await resolveDisplayTemplate("everyday-board");
    expect(resolved?.source).toBe("override");
    expect(resolved?.definition.name).toBe("Everyday board (club edit)");
  });

  it("resolves a CUSTOM row with the same uniform schema", async () => {
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({
      key: "our-foyer",
      source: "CUSTOM",
      definition: {
        key: "our-foyer",
        name: "Our foyer",
        regions: [
          { key: "main", panels: [{ module: "welcome" }, { module: "chores-board" }] },
        ],
      },
    });
    const { resolveDisplayTemplate } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    const resolved = await resolveDisplayTemplate("our-foyer");
    expect(resolved?.source).toBe("custom");
  });

  it("rejects an invalid STORED definition at load rather than rendering it", async () => {
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({
      key: "everyday-board",
      source: "BUILT_IN_OVERRIDE",
      definition: {
        key: "everyday-board",
        name: "Broken edit",
        regions: [{ key: "main", panels: [{ module: "not-a-module" }] }],
      },
    });
    const { resolveDisplayTemplate } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    const { InvalidDisplayTemplateError } = await import(
      "@/lib/lodge-display/template-registry"
    );
    await expect(resolveDisplayTemplate("everyday-board")).rejects.toThrow(
      InvalidDisplayTemplateError
    );
  });

  it("returns null for an unknown key", async () => {
    const { resolveDisplayTemplate } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    expect(await resolveDisplayTemplate("nope")).toBeNull();
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
