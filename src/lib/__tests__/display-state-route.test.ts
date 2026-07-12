import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #52 (LTV-013): the /api/display/state auth matrix. The route serves
// two callers — a paired device (whose poll doubles as the heartbeat) and an
// admin preview (?previewDevice / ?preview) which must be read-only: it never
// stamps lastSeenAt and is honoured only for a full-admin session.

const {
  mockPrisma,
  mockAuth,
  mockCheckDisplayAuth,
  mockBuildDisplayState,
  mockResolveTemplate,
  mockResolveForDevice,
  mockGetDefaultLodgeId,
} = vi.hoisted(() => ({
  mockPrisma: {
    member: { findUnique: vi.fn() },
    lodgeDisplayDevice: { findUnique: vi.fn(), update: vi.fn() },
    displayTemplate: { findUnique: vi.fn() },
    $queryRaw: vi.fn().mockRejectedValue(new Error("no shared store in tests")),
    $executeRaw: vi
      .fn()
      .mockRejectedValue(new Error("no shared store in tests")),
  },
  mockAuth: vi.fn(),
  mockCheckDisplayAuth: vi.fn(),
  mockBuildDisplayState: vi.fn(),
  mockResolveTemplate: vi.fn(),
  mockResolveForDevice: vi.fn(),
  mockGetDefaultLodgeId: vi.fn(),
}));

// The layoutRender path (LTV-027) exercises the REAL layout validator +
// sanitiser (page-content-html), so it is not mocked — but page-content-html
// pulls in `server-only`, which throws outside an RSC context; stub it.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/lodge-display-auth", () => ({
  checkDisplayAuth: (...args: unknown[]) => mockCheckDisplayAuth(...args),
}));
vi.mock("@/lib/lodge-display-state", () => ({
  buildDisplayState: (...args: unknown[]) => mockBuildDisplayState(...args),
}));
vi.mock("@/lib/lodge-display/template-resolution", () => ({
  resolveDisplayTemplate: (...args: unknown[]) => mockResolveTemplate(...args),
  resolveDisplayTemplateForDevice: (...args: unknown[]) =>
    mockResolveForDevice(...args),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...args: unknown[]) => mockGetDefaultLodgeId(...args),
}));

const STATE = { lodge: { name: "Silverpeak Lodge" }, rooms: [] };
const TEMPLATE = { key: "everyday-board", definition: { regions: [] } };
const ADMIN_MEMBER = { id: "admin-1", accessRoles: [{ role: "ADMIN" }] };
const PLAIN_MEMBER = { id: "member-1", accessRoles: [{ role: "USER" }] };
const DEVICE_AUTH = {
  device: {
    id: "dev-1",
    lodgeId: "lodge-a",
    name: "Lobby TV",
    templateId: null,
    templateKey: null,
  },
};

let nextIp = 1;
async function stateRequest(query = "") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/display/state${query}`, {
    headers: { "x-forwarded-for": `10.52.0.${(nextIp++ % 250) + 1}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckDisplayAuth.mockResolvedValue(null);
  mockAuth.mockResolvedValue(null);
  mockPrisma.member.findUnique.mockResolvedValue(null);
  mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue(null);
  mockPrisma.lodgeDisplayDevice.update.mockResolvedValue({});
  mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
  mockBuildDisplayState.mockResolvedValue(STATE);
  // Template resolution is synchronous (LTV-024 — code built-ins, no DB).
  mockResolveTemplate.mockReturnValue(TEMPLATE);
  mockResolveForDevice.mockReturnValue(TEMPLATE);
  mockGetDefaultLodgeId.mockResolvedValue("lodge-default");
});

describe("GET /api/display/state — device path", () => {
  it("serves the device's lodge and stamps lastSeenAt (the poll is the heartbeat)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-a", {
      days: null,
    });
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalledWith({
      where: { id: "dev-1" },
      data: { lastSeenAt: expect.any(Date) },
    });
  });

  it("returns 401 without a token and updates nothing", async () => {
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest());
    expect(res.status).toBe(401);
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });
});

describe("GET /api/display/state — admin preview (issue #52)", () => {
  function loginAs(member: typeof ADMIN_MEMBER) {
    mockAuth.mockResolvedValue({ user: { id: member.id } });
    mockPrisma.member.findUnique.mockResolvedValue(member);
  }

  it("rejects a preview without a session", async () => {
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?preview=1"));
    expect(res.status).toBe(401);
  });

  it("rejects a preview from a non-admin session", async () => {
    loginAs(PLAIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?previewDevice=dev-1"));
    expect(res.status).toBe(401);
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
  });

  it("previewDevice serves that device's lodge and template WITHOUT stamping lastSeenAt", async () => {
    loginAs(ADMIN_MEMBER);
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      lodgeId: "lodge-b",
      templateId: "tpl-1",
      templateKey: "occupancy-rotating",
    });
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?previewDevice=dev-9"));
    expect(res.status).toBe(200);
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-b", {
      days: null,
      windowStart: null,
    });
    expect(mockResolveTemplate).toHaveBeenCalledWith("occupancy-rotating");
    // Read-only by construction: a preview must never look like a live screen.
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("rejects a preview of an unknown device", async () => {
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?previewDevice=missing"));
    expect(res.status).toBe(401);
  });

  it("?preview=1 serves the default lodge with the requested templateKey", async () => {
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(
      await stateRequest("?preview=1&templateKey=room-occupancy-week")
    );
    expect(res.status).toBe(200);
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-default", {
      days: null,
      windowStart: null,
    });
    expect(mockResolveTemplate).toHaveBeenCalledWith("room-occupancy-week");
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("falls back to default resolution when the requested templateKey is unknown", async () => {
    loginAs(ADMIN_MEMBER);
    mockResolveTemplate.mockReturnValue(null);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?preview=1&templateKey=nope"));
    expect(res.status).toBe(200);
    expect(mockResolveForDevice).toHaveBeenCalled();
  });

  it("a paired device wins over preview parameters (device path first)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?previewDevice=dev-9"));
    expect(res.status).toBe(200);
    // The device cookie's lodge, not the preview target.
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-a", {
      days: null,
    });
  });

  it("?previewDate simulates the window start for an admin preview (issue #60)", async () => {
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?preview=1&previewDate=2026-08-01"));
    expect(res.status).toBe(200);
    const [, options] = mockBuildDisplayState.mock.calls[0];
    expect(options.windowStart).toBeInstanceOf(Date);
    expect((options.windowStart as Date).toISOString().slice(0, 10)).toBe(
      "2026-08-01"
    );
  });

  it("a malformed previewDate falls back to today silently", async () => {
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?preview=1&previewDate=next-week"));
    expect(res.status).toBe(200);
    const [, options] = mockBuildDisplayState.mock.calls[0];
    expect(options.windowStart ?? null).toBeNull();
  });

  it("never honours previewDate on a device-token fetch (device path is date-blind)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?previewDate=2026-08-01"));
    expect(res.status).toBe(200);
    const [lodgeId, options] = mockBuildDisplayState.mock.calls[0];
    expect(lodgeId).toBe("lodge-a");
    expect(options.windowStart ?? null).toBeNull();
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalled();
  });
});

describe("GET /api/display/state — v2 layoutRender path (LTV-027)", () => {
  const DEVICE_AUTH_V2 = {
    device: {
      id: "dev-2",
      lodgeId: "lodge-a",
      name: "Lobby TV",
      templateId: "tpl-42",
      templateKey: null,
    },
  };

  // A valid stored Layout+Template with hostile HTML/CSS to prove serve-time
  // sanitisation + `</style` stripping.
  const VALID_TEMPLATE = {
    slotContent: { main: { html: "<p>Hi</p><script>steal()</script>" } },
    cssOverrides: ".x{color:blue}",
    footerHtml: "<b>Wi-Fi</b><script>evil()</script>",
    layout: {
      bodyHtml: "<h1>Wall</h1><script>alert(1)</script>{{area:main}}",
      defaultCss: "body{color:red}</style><script>y()</script>",
      areas: [{ key: "main", description: "Main", kind: "static" }],
    },
  };

  it("attaches a sanitised layoutRender for a device bound to a v2 template", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH_V2);
    mockPrisma.displayTemplate.findUnique.mockResolvedValue(VALID_TEMPLATE);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    expect(mockPrisma.displayTemplate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tpl-42" } })
    );
    const body = await res.json();
    expect(body.layoutRender).toBeDefined();
    // Script tags stripped from every admin HTML field at serve time.
    expect(body.layoutRender.bodyHtml).not.toMatch(/<script/i);
    expect(body.layoutRender.bodyHtml).toContain("{{area:main}}");
    expect(body.layoutRender.slotContent.main.html).not.toMatch(/<script/i);
    expect(body.layoutRender.footerHtml).not.toMatch(/<script/i);
    // `</style` stripped from CSS so authored CSS cannot break out of <style>.
    expect(body.layoutRender.defaultCss).not.toMatch(/<\/style/i);
    // The legacy template still ships as the safe fallback.
    expect(body.template).toBeDefined();
    // The device heartbeat still stamps on the v2 path.
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalled();
  });

  it("falls back to the legacy template when the stored layout is invalid", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH_V2);
    // areas do not match the body placeholder → buildLayoutRender throws.
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({
      ...VALID_TEMPLATE,
      layout: { ...VALID_TEMPLATE.layout, areas: [] },
    });
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layoutRender).toBeUndefined();
    expect(body.template).toBeDefined();
  });

  it("falls back to the legacy template when the template row is missing", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH_V2);
    mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layoutRender).toBeUndefined();
    expect(body.template).toBeDefined();
  });

  it("a device without templateId never loads a layout (legacy unchanged)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layoutRender).toBeUndefined();
    expect(mockPrisma.displayTemplate.findUnique).not.toHaveBeenCalled();
  });

  it("?preview=1 (no templateId) never loads a layout", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN_MEMBER.id } });
    mockPrisma.member.findUnique.mockResolvedValue(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?preview=1&templateKey=everyday-board"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layoutRender).toBeUndefined();
    expect(mockPrisma.displayTemplate.findUnique).not.toHaveBeenCalled();
  });
});
