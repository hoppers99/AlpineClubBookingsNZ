import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  bookingsAdminSession,
  contentAdminSession,
  readOnlyAdminSession,
} from "./helpers/admin-area-gate-sessions";

const mockAuth = vi.fn();
const mockChoreCreate = vi.fn();
const mockChoreFindMany = vi.fn();
const mockLodgeFindFirst = vi.fn();
const mockLodgeFindUnique = vi.fn();
const mockAuditCreate = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    choreTemplate: {
      create: mockChoreCreate,
      findMany: mockChoreFindMany,
    },
    lodge: {
      findFirst: mockLodgeFindFirst,
      findUnique: mockLodgeFindUnique,
    },
    auditLog: {
      create: mockAuditCreate,
    },
  },
}));

describe("POST /api/admin/chores", () => {
  let POST: typeof import("@/app/api/admin/chores/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockChoreCreate.mockResolvedValue({ id: "ct1" });
    mockLodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    mockAuditCreate.mockResolvedValue({});
    const mod = await import("@/app/api/admin/chores/route");
    POST = mod.POST;
  });

  it("rejects SPECIFIC_DAYS chores with no selected weekdays", async () => {
    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({
        name: "Deep Clean",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.frequencyDaysOfWeek?.[0]).toContain(
      "at least one day"
    );
    expect(mockChoreCreate).not.toHaveBeenCalled();
  });

  it("accepts SPECIFIC_DAYS chores when weekdays are provided", async () => {
    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({
        name: "Deep Clean",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [1, 4],
      }),
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(mockChoreCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Deep Clean",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [1, 4],
        lodgeId: "lodge-1",
      }),
    });
    // #1988: the create must leave a member-actor audit row so the
    // bootstrap-import six-signal probe (signal 6) detects hand-configured
    // chore templates.
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CHORE_TEMPLATE_CREATED",
        actorMemberId: "admin1",
        entityType: "ChoreTemplate",
      }),
    });
  });

  it("creates a chore at an explicitly requested active lodge", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({ name: "Sweep Deck", lodgeId: "lodge-2" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(mockChoreCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Sweep Deck", lodgeId: "lodge-2" }),
    });
  });

  /*
    #221 changed the answer here. These admin routes configure a lodge's own
    inventory, so they moved onto `resolveOptionalConfigurableLodgeId`: an
    INACTIVE lodge is accepted, because a lodge created through the admin route
    now starts inactive and its rooms, lockers, seasons and chores have to be
    buildable before it is activated. An UNKNOWN lodge is still refused. Nothing
    bookable widens — `Lodge.active` is enforced at the booking surfaces.
  */
  it("creates a chore at an INACTIVE lodge, which is the one being set up (#221)", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2" });

    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({ name: "Sweep Deck", lodgeId: "lodge-2" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(mockChoreCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Sweep Deck", lodgeId: "lodge-2" }),
    });
  });

  it("still rejects creating a chore at a lodge that does not exist", async () => {
    mockLodgeFindUnique.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({ name: "Sweep Deck", lodgeId: "nope" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockChoreCreate).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/chores", () => {
  let GET: typeof import("@/app/api/admin/chores/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockChoreFindMany.mockResolvedValue([]);
    const mod = await import("@/app/api/admin/chores/route");
    GET = mod.GET;
  });

  it("lists every template when no lodge filter is given", async () => {
    const res = await GET(new NextRequest("http://localhost/api/admin/chores"));

    expect(res.status).toBe(200);
    expect(mockChoreFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined })
    );
  });

  it("filters templates strictly to a lodge", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const res = await GET(
      new NextRequest("http://localhost/api/admin/chores?lodgeId=lodge-2")
    );

    expect(res.status).toBe(200);
    expect(mockChoreFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      })
    );
  });

  it("lists chores at an INACTIVE lodge, so its setup page is readable (#221)", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2" });

    const res = await GET(
      new NextRequest("http://localhost/api/admin/chores?lodgeId=lodge-2")
    );

    expect(res.status).toBe(200);
    expect(mockChoreFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lodgeId: "lodge-2" } })
    );
  });

  it("still rejects listing chores at a lodge that does not exist (Low 2)", async () => {
    mockLodgeFindUnique.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/admin/chores?lodgeId=nope")
    );

    expect(res.status).toBe(400);
    expect(mockChoreFindMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-area gate (#2921). This is the file the issue used as its worked example:
// GET declares `{ area: "lodge", level: "view" }` and POST declares
// `{ area: "lodge", level: "edit" }`, and before the sweep the mock never saw
// either — so a role holding only `lodge:view` was accepted by the POST test and
// nothing in this file could tell the two gates apart.
//
// These four assertions pin both halves of each requirement. Weaken POST to
// `level: "view"` and the read-only denial flips to a 201; re-point either
// handler at `{ area: "overview", level: "view" }` — the fork PR #2949 shape —
// and the content-admin denials flip too.
// ---------------------------------------------------------------------------
describe("per-area gate on /api/admin/chores (#2921)", () => {
  let GET: typeof import("@/app/api/admin/chores/route").GET;
  let POST: typeof import("@/app/api/admin/chores/route").POST;

  function createRequest() {
    return new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({ name: "Sweep Deck" }),
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockChoreFindMany.mockResolvedValue([]);
    mockChoreCreate.mockResolvedValue({ id: "ct1" });
    mockLodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    mockAuditCreate.mockResolvedValue({});
    const mod = await import("@/app/api/admin/chores/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  it("admits a view-only admin on the lodge:view read", async () => {
    mockAuth.mockResolvedValue(readOnlyAdminSession);

    const res = await GET(new NextRequest("http://localhost/api/admin/chores"));

    expect(res.status).toBe(200);
  });

  it("refuses a view-only admin on the lodge:edit write", async () => {
    mockAuth.mockResolvedValue(readOnlyAdminSession);

    const res = await POST(createRequest());

    expect(res.status).toBe(403);
    expect(mockChoreCreate).not.toHaveBeenCalled();
  });

  it("refuses an admin with no lodge access at all, on both handlers", async () => {
    mockAuth.mockResolvedValue(contentAdminSession);

    const read = await GET(new NextRequest("http://localhost/api/admin/chores"));
    const write = await POST(createRequest());

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(mockChoreFindMany).not.toHaveBeenCalled();
    expect(mockChoreCreate).not.toHaveBeenCalled();
  });

  it("admits a lodge-editing admin on the lodge:edit write", async () => {
    mockAuth.mockResolvedValue(bookingsAdminSession);

    const res = await POST(createRequest());

    expect(res.status).toBe(201);
    expect(mockChoreCreate).toHaveBeenCalled();
  });
});
