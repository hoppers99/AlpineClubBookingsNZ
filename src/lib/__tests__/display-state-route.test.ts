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
    regionConfig: null,
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
  mockBuildDisplayState.mockResolvedValue(STATE);
  mockResolveTemplate.mockResolvedValue(TEMPLATE);
  mockResolveForDevice.mockResolvedValue(TEMPLATE);
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
    mockResolveTemplate.mockResolvedValue(null);
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
