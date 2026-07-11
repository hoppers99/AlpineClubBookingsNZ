import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #34 (LTV-009): template management, lodge display settings, and the
// read-only preview — save validation against the closed registries (AC8),
// copy-to-custom never touching code defaults (AC1/AC2), explicit config
// validation errors (AC4), granularity persistence (AC6), admin-only (AC7),
// and the preview making NO database write (AC3).

const { mockPrisma, mockRequireAdmin } = vi.hoisted(() => ({
  mockPrisma: {
    displayTemplate: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    lodge: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    lodgeRoom: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
  },
  mockRequireAdmin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn().mockResolvedValue("lodge-default"),
  lodgeNullTolerantScope: (lodgeId: string) => ({ OR: [{ lodgeId }, { lodgeId: null }] }),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi
    .fn()
    .mockResolvedValue({ bedAllocation: false, chores: false }),
}));
vi.mock("@/lib/lodge-instructions", () => ({
  getSanitizedLodgeInstructions: vi.fn().mockResolvedValue([]),
}));

async function jsonRequest(url: string, method: string, body?: unknown) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
  mockPrisma.displayTemplate.findMany.mockResolvedValue([]);
  mockPrisma.displayTemplate.create.mockResolvedValue({
    key: "our-foyer",
    name: "Our foyer",
    source: "CUSTOM",
  });
  mockPrisma.displayTemplate.upsert.mockResolvedValue({
    key: "everyday-board",
    source: "BUILT_IN_OVERRIDE",
  });
  mockPrisma.lodge.findUnique.mockResolvedValue({
    id: "lodge-default",
    name: "Silverpeak Lodge",
    active: true,
    displayConfig: { "wifi-code": "alpine1234" },
    displayNameGranularity: null,
  });
  mockPrisma.lodge.update.mockResolvedValue({});
});

describe("PUT /api/admin/display/templates/[key] (AC8)", () => {
  const routeParams = { params: Promise.resolve({ key: "everyday-board" }) };

  it("rejects a definition with an unknown module before persisting", async () => {
    const { PUT } = await import("@/app/api/admin/display/templates/[key]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        definition: {
          key: "everyday-board",
          name: "Broken",
          regions: [{ key: "main", panels: [{ module: "bitcoin-ticker" }] }],
        },
      }),
      routeParams
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown module "bitcoin-ticker"/);
    expect(mockPrisma.displayTemplate.upsert).not.toHaveBeenCalled();
  });

  it("saves a valid override without touching the code default (AC2)", async () => {
    const { PUT } = await import("@/app/api/admin/display/templates/[key]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        definition: {
          key: "everyday-board",
          name: "Everyday (club edit)",
          regions: [{ key: "main", panels: [{ module: "arrivals-board" }] }],
        },
      }),
      routeParams
    );
    expect(res.status).toBe(200);
    const upsert = mockPrisma.displayTemplate.upsert.mock.calls[0][0];
    expect(upsert.create.source).toBe("BUILT_IN_OVERRIDE");
    // The built-in code registry is untouched — only a DB row is written.
    const { listBuiltInDisplayTemplates } = await import(
      "@/lib/lodge-display/template-registry"
    );
    expect(
      listBuiltInDisplayTemplates().find((t) => t.key === "everyday-board")?.name
    ).toBe("Everyday board");
  });
});

describe("POST /api/admin/display/templates (copy-to-custom, AC1)", () => {
  it("clones a built-in into a CUSTOM row with a new key and name", async () => {
    const { POST } = await import("@/app/api/admin/display/templates/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", {
        fromKey: "everyday-board",
        key: "our-foyer",
        name: "Our foyer",
      })
    );
    expect(res.status).toBe(201);
    const create = mockPrisma.displayTemplate.create.mock.calls[0][0];
    expect(create.data.source).toBe("CUSTOM");
    expect(create.data.definition.key).toBe("our-foyer");
    expect(create.data.definition.regions.length).toBeGreaterThan(0);
  });

  it("refuses to shadow an existing or built-in key", async () => {
    const { POST } = await import("@/app/api/admin/display/templates/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", {
        fromKey: "everyday-board",
        key: "whole-lodge",
        name: "Sneaky",
      })
    );
    expect(res.status).toBe(409);
  });
});

describe("lodge display settings (AC4/AC5/AC6)", () => {
  it("rejects bad config keys and oversized values with explicit errors", async () => {
    const { PUT } = await import("@/app/api/admin/display/lodge-config/route");
    const badKey = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        displayConfig: { "Bad Key!": "x" },
      })
    );
    expect(badKey.status).toBe(400);
    expect((await badKey.json()).error).toContain('"Bad Key!"');

    const tooLong = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        displayConfig: { note: "x".repeat(501) },
      })
    );
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toContain("exceeds 500");
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
  });

  it("persists a valid glob and the granularity override (AC5/AC6)", async () => {
    const { PUT } = await import("@/app/api/admin/display/lodge-config/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        displayConfig: { "wifi-code": "alpine1234" },
        displayNameGranularity: "FULL_NAME",
      })
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.lodge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lodge-default" },
        data: {
          displayConfig: { "wifi-code": "alpine1234" },
          displayNameGranularity: "FULL_NAME",
        },
      })
    );
  });

  it("requires an admin session (AC7)", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/display/lodge-config/route");
    const res = await GET(await jsonRequest("http://localhost/x", "GET"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/display/preview (AC3 — read-only)", () => {
  it("returns the template plus the privacy-reduced state and performs NO write", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
    const { GET } = await import("@/app/api/admin/display/preview/route");
    const res = await GET(
      await jsonRequest(
        "http://localhost/api/admin/display/preview?templateKey=everyday-board",
        "GET"
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template.key).toBe("everyday-board");
    expect(body.state.lodge.name).toBe("Silverpeak Lodge");

    // No mutation of ANY kind happened on the preview path.
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
    expect(mockPrisma.displayTemplate.create).not.toHaveBeenCalled();
    expect(mockPrisma.displayTemplate.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.displayTemplate.update).not.toHaveBeenCalled();
    expect(mockPrisma.displayTemplate.delete).not.toHaveBeenCalled();
  });

  it("404s an unknown template", async () => {
    const { GET } = await import("@/app/api/admin/display/preview/route");
    const res = await GET(
      await jsonRequest(
        "http://localhost/api/admin/display/preview?templateKey=nope",
        "GET"
      )
    );
    expect(res.status).toBe(404);
  });
});
