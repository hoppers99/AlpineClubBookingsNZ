import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_DISPLAY_LAYOUTS,
  BUILT_IN_DISPLAY_TEMPLATES,
  ensureBuiltInDisplays,
  type EnsureBuiltInDisplaysClient,
} from "@/lib/lodge-display/built-in-seeds";

// LTV-038: the three built-ins seeded as v2 Layout + Template rows. These tests
// cover the SEED CONTRACT (create-if-missing, admin-safe, idempotent) and the
// device templateKey→templateId migration, without a database — a structural
// mock captures the upsert/updateMany shapes. The layout-render VALIDITY of the
// seeded definitions (they build cleanly through the real server assembler) is
// asserted in lodge-display-layout-render.test.ts's LTV-038 block.

interface UpsertCall {
  where: { key: string };
  update: Record<string, unknown>;
  create: { id: string; key: string; layoutId?: string };
}

interface UpdateManyCall {
  where: { templateKey: string; templateId: null };
  data: { templateId: string; templateKey: null };
}

function makeClient(migratedPerKey: Record<string, number> = {}) {
  const layoutUpserts: UpsertCall[] = [];
  const templateUpserts: UpsertCall[] = [];
  const updateManyCalls: UpdateManyCall[] = [];
  const client: EnsureBuiltInDisplaysClient = {
    displayLayout: {
      upsert: vi.fn(async (args) => {
        layoutUpserts.push(args as unknown as UpsertCall);
        return { id: (args.create as { id: string }).id };
      }),
    },
    displayTemplate: {
      upsert: vi.fn(async (args) => {
        templateUpserts.push(args as unknown as UpsertCall);
        return { id: (args.create as { id: string }).id };
      }),
    },
    lodgeDisplayDevice: {
      updateMany: vi.fn(async (args) => {
        const call = args as unknown as UpdateManyCall;
        updateManyCalls.push(call);
        return { count: migratedPerKey[call.where.templateKey] ?? 0 };
      }),
    },
  };
  return { client, layoutUpserts, templateUpserts, updateManyCalls };
}

describe("built-in display seeds — definitions", () => {
  it("defines exactly the three built-ins keyed to the legacy code built-ins", () => {
    expect(BUILT_IN_DISPLAY_LAYOUTS.map((l) => l.key)).toEqual([
      "everyday-board",
      "whole-lodge",
      "singles-house",
    ]);
    expect(BUILT_IN_DISPLAY_TEMPLATES.map((t) => t.key)).toEqual([
      "everyday-board",
      "whole-lodge",
      "singles-house",
    ]);
    // Every template binds a layout that exists in the seed set.
    for (const template of BUILT_IN_DISPLAY_TEMPLATES) {
      expect(
        BUILT_IN_DISPLAY_LAYOUTS.some((l) => l.key === template.layoutKey)
      ).toBe(true);
    }
  });

  it("re-creates the everyday-board board+rail page grid in the layout CSS", () => {
    const everyday = BUILT_IN_DISPLAY_LAYOUTS.find(
      (l) => l.key === "everyday-board"
    )!;
    // The two-column board+rail treatment (legacy .display-screen:has(side)) and
    // the stacked rail (legacy .display-region-stack) live in the layout CSS now.
    expect(everyday.defaultCss).toContain("grid-template-columns: 1fr 27vw");
    expect(everyday.defaultCss).toContain(".eb-rail");
    // The compact notice-card treatment travels too.
    expect(everyday.defaultCss).toContain(".eb-rail .display-notice-board");
    // The body nests the rail areas inside a rail container (LTV-041 nesting).
    expect(everyday.bodyHtml).toContain('<div class="eb-rail">');
    expect(everyday.bodyHtml).toContain("{{area:chores}}");
    expect(everyday.bodyHtml).toContain("{{area:notice}}");
  });
});

describe("ensureBuiltInDisplays — seed contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts each layout and template create-if-missing (empty update never clobbers admin edits)", async () => {
    const { client, layoutUpserts, templateUpserts } = makeClient();
    await ensureBuiltInDisplays(client);

    expect(layoutUpserts).toHaveLength(3);
    expect(templateUpserts).toHaveLength(3);
    // Create-if-missing: EVERY upsert carries an empty update, so a re-run (or an
    // admin-customised row) is never overwritten.
    for (const call of [...layoutUpserts, ...templateUpserts]) {
      expect(call.update).toEqual({});
      expect(call.where.key).toBe(call.create.key);
    }
    // Templates bind their layout by the deterministic built-in layout id.
    const everydayTemplate = templateUpserts.find(
      (c) => c.create.key === "everyday-board"
    )!;
    expect(everydayTemplate.create.layoutId).toBe("builtin-layout-everyday-board");
  });

  it("migrates devices from a legacy templateKey onto the seeded templateId, only where unbound", async () => {
    const { client, updateManyCalls } = makeClient({
      "everyday-board": 2,
      "whole-lodge": 1,
    });
    const result = await ensureBuiltInDisplays(client);

    // One migration per built-in, gated on an empty v2 binding.
    expect(updateManyCalls).toHaveLength(3);
    for (const call of updateManyCalls) {
      expect(call.where.templateId).toBeNull();
      expect(call.data.templateKey).toBeNull();
      expect(call.data.templateId).toBe(`builtin-template-${call.where.templateKey}`);
    }
    // The result aggregates the migrated counts across built-ins (2 + 1 + 0).
    expect(result.migratedDeviceCount).toBe(3);
  });

  it("is idempotent: a second run creates nothing new and migrates nothing (no key matches)", async () => {
    // A populated DB: layouts/templates already exist (upsert update is empty, a
    // no-op) and no device still carries a legacy key, so updateMany matches 0.
    const { client, updateManyCalls } = makeClient();
    const first = await ensureBuiltInDisplays(client);
    const second = await ensureBuiltInDisplays(client);

    expect(first.migratedDeviceCount).toBe(0);
    expect(second.migratedDeviceCount).toBe(0);
    // Every migration query is scoped to devices that still carry the key AND
    // have no templateId — so once migrated (key cleared) it matches nothing.
    for (const call of updateManyCalls) {
      expect(call.where).toEqual({
        templateKey: call.where.templateKey,
        templateId: null,
      });
    }
  });
});
