import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET`/`PUT /api/admin/lodge-settings` is a CONFIGURATION surface (#221).
 *
 * The per-lodge capacity override is part of setting a lodge up, and the setup
 * flow reaches this route: its finish step offers "Open lodge configuration",
 * and `/admin/lodges/[id]` reads this route on load and writes the override
 * from its own editor. While the scope check was active-only, a lodge created
 * through the setup flow — which now starts inactive — made that GET fail
 * silently (the page swallows a non-ok response, so the field simply stayed
 * blank) and made the PUT answer "Lodge not found or not active" for a lodge
 * the operator was plainly looking at.
 *
 * Three properties, and the SIDE EFFECT is asserted in each rather than the
 * status alone: a 200 that read or wrote the wrong settings row would satisfy a
 * status-only test perfectly.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  lodgeFindUnique: vi.fn(),
  loadLodgeSettings: vi.fn(),
  updateLodgeSettings: vi.fn(),
  createAuditLog: vi.fn(),
  revalidatePublicSite: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));

vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));

vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: mocks.revalidatePublicSite,
}));

vi.mock("@/lib/lodge-settings", () => ({
  loadLodgeSettings: mocks.loadLodgeSettings,
  updateLodgeSettings: mocks.updateLodgeSettings,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: mocks.lodgeFindUnique } },
}));

import { GET, PUT } from "@/app/api/admin/lodge-settings/route";

const SETTINGS = {
  capacity: 24,
  hutLeaderLookaheadDays: 14,
  schoolGroupSoftCap: null,
};

function lodgeAdmin() {
  return {
    user: {
      id: "admin-1",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN" }],
      adminPermissionMatrix: {
        overview: "edit",
        bookings: "edit",
        membership: "edit",
        finance: "edit",
        lodge: "edit",
        content: "edit",
        support: "edit",
      },
    },
  };
}

function put(body: unknown) {
  return new Request("http://localhost/api/admin/lodge-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(lodgeAdmin());
  mocks.loadLodgeSettings.mockResolvedValue(SETTINGS);
  mocks.updateLodgeSettings.mockResolvedValue({ ...SETTINGS, capacity: 30 });
});

describe("lodge-settings accepts a lodge that is not open yet (#221)", () => {
  it("READS the named inactive lodge's own settings row", async () => {
    // `select: { id: true }` — the configuration resolver does not look at
    // `active` at all, so the row it returns carries no flag to consult.
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2" });

    const res = await GET(
      new Request(
        "http://localhost/api/admin/lodge-settings?lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(200);
    // THE POINT: not merely a 200, but a 200 about lodge-2.
    expect(mocks.loadLodgeSettings).toHaveBeenCalledWith(
      expect.anything(),
      "lodge-2",
    );
  });

  it("WRITES the named inactive lodge's capacity override", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2" });

    const res = await PUT(put({ capacity: 30, lodgeId: "lodge-2" }));

    expect(res.status).toBe(200);
    expect(mocks.updateLodgeSettings).toHaveBeenCalledWith(
      expect.objectContaining({ capacity: 30, lodgeId: "lodge-2" }),
    );
  });

  it("still refuses an id that names no lodge, and writes nothing", async () => {
    // The half of the old check that was doing real work is kept.
    mocks.lodgeFindUnique.mockResolvedValue(null);

    const res = await PUT(put({ capacity: 30, lodgeId: "nope" }));

    expect(res.status).toBe(400);
    expect(mocks.updateLodgeSettings).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicSite).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("keeps the legacy club-wide row when no lodgeId is sent", async () => {
    /*
      The omitted case deliberately does NOT take the configuration resolver's
      default-lodge fallback: `null` means the legacy single settings row, which
      `loadLodgeSettings` and `updateLodgeSettings` both key on. Resolving it to
      a lodge id would silently move which row this route reads and writes — a
      change nobody asked for, hidden inside a refusal fix.
    */
    const res = await PUT(put({ capacity: 30 }));

    expect(res.status).toBe(200);
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
    expect(mocks.updateLodgeSettings).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: undefined }),
    );
  });
});
