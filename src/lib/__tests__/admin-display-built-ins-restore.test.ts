import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_DISPLAY_LAYOUTS,
  BUILT_IN_DISPLAY_TEMPLATES,
} from "@/lib/lodge-display/built-in-seeds";

// POST /api/admin/display/built-ins/restore (#2247).
//
// The built-in boards are created only by `prisma/seed.ts`, and no deploy or
// upgrade path re-runs the seed, so a database that predates the lobby-display
// feature has no `builtin-*` rows at all. This route is the operator's way to
// create them — and, because `ensureBuiltInDisplays` is a CONVERGENT upsert, to
// pull an edited built-in back to its shipped definition.
//
// The prisma double below implements REAL upsert-by-key semantics (create when
// absent, merge the update block when present) rather than returning canned
// values, because the properties under test — idempotency and convergence — are
// properties of those semantics. A mock that just records calls would pass
// whatever the route did.

interface Row {
  id: string;
  key: string;
  [field: string]: unknown;
}

function makeStore(initial?: Map<string, Row>) {
  // Deep-ish copy so a draft's writes cannot mutate the committed rows through
  // a shared object reference — otherwise "rolled back" would be untestable.
  const rows = new Map<string, Row>(
    [...(initial ?? new Map<string, Row>())].map(([key, row]) => [
      key,
      { ...row },
    ])
  );
  return {
    rows,
    upsert: vi.fn(
      async ({
        where,
        update,
        create,
      }: {
        where: { key: string };
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        const existing = rows.get(where.key);
        if (existing) {
          // Prisma merges the update block into the existing row, leaving the
          // id (and any field the block omits) alone.
          Object.assign(existing, update);
          return { id: existing.id };
        }
        const row = { ...create } as Row;
        rows.set(where.key, row);
        return { id: row.id };
      }
    ),
  };
}

const { mockPrisma, mockRequireAdmin, mockLogAudit } = vi.hoisted(() => ({
  mockPrisma: {
    displayLayout: { upsert: vi.fn() },
    displayTemplate: { upsert: vi.fn() },
    // The restore runs inside one transaction so a mid-sequence failure cannot
    // leave a half-restored library. The double runs the callback against a
    // SNAPSHOT and only commits it if the callback resolves — the property
    // under test is all-or-nothing, so a passthrough `$transaction` would make
    // the transaction assertions vacuous.
    $transaction: vi.fn(),
  },
  mockRequireAdmin: vi.fn(),
  mockLogAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

let layoutStore: ReturnType<typeof makeStore>;
let templateStore: ReturnType<typeof makeStore>;

/**
 * A `$transaction` double with REAL rollback: the callback is handed a client
 * writing into copies of the two stores, and the copies are published back only
 * when it resolves. If it throws, the committed stores are untouched — which is
 * what "atomic" has to mean for the partial-failure test to prove anything.
 */
function installTransaction() {
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const layoutDraft = makeStore(new Map(layoutStore.rows));
      const templateDraft = makeStore(new Map(templateStore.rows));
      const result = await fn({
        displayLayout: { upsert: layoutDraft.upsert },
        displayTemplate: { upsert: templateDraft.upsert },
      });
      layoutStore.rows = layoutDraft.rows;
      templateStore.rows = templateDraft.rows;
      return result;
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  layoutStore = makeStore();
  templateStore = makeStore();
  mockPrisma.displayLayout.upsert = layoutStore.upsert;
  mockPrisma.displayTemplate.upsert = templateStore.upsert;
  installTransaction();
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
});

async function post() {
  const { POST } = await import(
    "@/app/api/admin/display/built-ins/restore/route"
  );
  return POST();
}

describe("POST /api/admin/display/built-ins/restore", () => {
  it("is gated on lodge EDIT, not the sibling reads' lodge:view", async () => {
    await post();
    expect(mockRequireAdmin).toHaveBeenCalledWith({
      permission: { area: "lodge", level: "edit" },
    });
  });

  it("refuses a view-only admin and writes nothing", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const res = await post();

    expect(res.status).toBe(403);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(layoutStore.rows.size).toBe(0);
    expect(templateStore.rows.size).toBe(0);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("writes every row inside ONE transaction", async () => {
    await post();
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("creates every built-in layout and template on an unseeded database", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      layouts: BUILT_IN_DISPLAY_LAYOUTS.length,
      templates: BUILT_IN_DISPLAY_TEMPLATES.length,
    });
    expect([...layoutStore.rows.keys()].sort()).toEqual(
      BUILT_IN_DISPLAY_LAYOUTS.map((l) => l.key).sort()
    );
    expect([...templateStore.rows.keys()].sort()).toEqual(
      BUILT_IN_DISPLAY_TEMPLATES.map((t) => t.key).sort()
    );
  });

  it("audits the restore against the acting admin", async () => {
    await post();

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const entry = mockLogAudit.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.action).toBe("DISPLAY_BUILT_INS_RESTORED");
    expect(entry.actorMemberId).toBe("admin-1");
    // The overwrite is the part an operator will later query the log about, so
    // the details line has to say it happened…
    expect(String(entry.details)).toMatch(/overwritten/i);
    // …and has to name the keys it rewrote. "builtin-*" (the seeded ROW ID
    // prefix) matches no key at all and could not answer "was our board one of
    // them?", so the reserved KEYS are named instead.
    expect(String(entry.details)).not.toMatch(/builtin-\*/);
    for (const key of BUILT_IN_DISPLAY_TEMPLATES.map((t) => t.key)) {
      expect(String(entry.details)).toContain(key);
    }
  });

  it("is idempotent — a second run changes nothing", async () => {
    await post();
    const afterFirst = JSON.stringify([
      [...layoutStore.rows.entries()],
      [...templateStore.rows.entries()],
    ]);

    const res = await post();

    expect(await res.json()).toEqual({
      layouts: BUILT_IN_DISPLAY_LAYOUTS.length,
      templates: BUILT_IN_DISPLAY_TEMPLATES.length,
    });
    expect(
      JSON.stringify([
        [...layoutStore.rows.entries()],
        [...templateStore.rows.entries()],
      ])
    ).toBe(afterFirst);
  });

  it("converges an edited built-in back to its shipped definition", async () => {
    const seed = BUILT_IN_DISPLAY_TEMPLATES[0];
    const seedLayout = BUILT_IN_DISPLAY_LAYOUTS[0];
    // An operator edited the built-in in place (the thing the confirm dialog
    // warns about) under a row id the seed did not choose.
    templateStore.rows.set(seed.key, {
      id: "hand-made-id",
      key: seed.key,
      name: "Our tweaked board",
      layoutId: "some-layout",
      slotContent: { main: "<p>hand edited</p>" },
      cssOverrides: ".board { color: hotpink; }",
      footerHtml: "<p>ours</p>",
    });
    layoutStore.rows.set(seedLayout.key, {
      id: "hand-made-layout-id",
      key: seedLayout.key,
      name: "Our tweaked layout",
      description: "",
      bodyHtml: "<main></main>",
      defaultCss: "",
      areas: [],
    });
    // …and a custom template of their own, which must survive untouched.
    templateStore.rows.set("foyer-board", {
      id: "custom-1",
      key: "foyer-board",
      name: "Foyer board",
      cssOverrides: ".board { color: rebeccapurple; }",
    });

    await post();

    const restored = templateStore.rows.get(seed.key)!;
    expect(restored.name).toBe(seed.name);
    expect(restored.cssOverrides).toBe(seed.cssOverrides);
    expect(restored.footerHtml).toBe(seed.footerHtml);
    expect(restored.slotContent).toEqual(seed.slotContent);
    // The row keeps its identity, so devices bound by templateId stay bound.
    expect(restored.id).toBe("hand-made-id");
    // …and is re-bound to the layout row that actually exists under that key,
    // not to the deterministic built-in id.
    expect(restored.layoutId).toBe("hand-made-layout-id");

    const layout = layoutStore.rows.get(seedLayout.key)!;
    expect(layout.name).toBe(seedLayout.name);
    expect(layout.bodyHtml).toBe(seedLayout.bodyHtml);

    expect(templateStore.rows.get("foyer-board")).toEqual({
      id: "custom-1",
      key: "foyer-board",
      name: "Foyer board",
      cssOverrides: ".board { color: rebeccapurple; }",
    });
  });

  it("rolls the whole restore back when the database fails part-way", async () => {
    // Fail on the FOURTH layout upsert, i.e. genuinely mid-sequence: three
    // layouts have already been written inside the transaction. Without the
    // transaction those three would survive as a half-restored library that
    // nothing recorded — the failure mode this test exists for.
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const layoutDraft = makeStore(new Map(layoutStore.rows));
        const templateDraft = makeStore(new Map(templateStore.rows));
        let writes = 0;
        const result = await fn({
          displayLayout: {
            upsert: async (args: Parameters<typeof layoutDraft.upsert>[0]) => {
              if (++writes === 4) throw new Error("connection reset");
              return layoutDraft.upsert(args);
            },
          },
          displayTemplate: { upsert: templateDraft.upsert },
        });
        layoutStore.rows = layoutDraft.rows;
        templateStore.rows = templateDraft.rows;
        return result;
      }
    );

    const res = await post();

    expect(res.status).toBe(500);
    // All-or-nothing: the committed stores never saw the three partial writes.
    expect(layoutStore.rows.size).toBe(0);
    expect(templateStore.rows.size).toBe(0);
    // …and the operator is told it is safe to retry, because it truly is.
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/nothing was changed/i);
    expect(body.error).toMatch(/safe to try again/i);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
