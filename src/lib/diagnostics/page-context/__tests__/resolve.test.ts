/**
 * AID-4 (#2373) — the server re-fetch: authorization, IDOR, stale roles, the
 * sensitive opt-in, redaction, and route switching.
 *
 * These cover the acceptance criteria that are about BEHAVIOUR rather than
 * shape. The recurring assertion is negative: after a denial or an opt-out, the
 * thing that must be absent really is absent — not merely flagged.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  paymentFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    booking: { findUnique: mocks.bookingFindUnique },
    payment: { findUnique: mocks.paymentFindUnique },
  },
}));

import { resolveDiagnosticsPageContext } from "../resolve";
import { DIAGNOSTICS_SENSITIVE_INCLUSION_COPY } from "../types";

const OBSERVED_AT = new Date("2026-07-01T00:00:00.000Z");
const ACTOR = "cactor1";

/**
 * The acting admin's own row, shaped exactly like `MEMBER_ACCESS_ROLE_SELECT`
 * returns it — a custom role whose joined definition carries the per-area level
 * columns. These tests therefore exercise the REAL matrix derivation in
 * `getAdminPermissionMatrix`, not a stubbed matrix.
 */
function actorWith(levels: Partial<Record<string, "NONE" | "VIEW" | "EDIT">>) {
  return {
    canLogin: true,
    accessRoles: [
      {
        role: "ADMIN_READONLY",
        roleDefinitionId: "crole1",
        roleDefinition: {
          id: "crole1",
          key: "custom",
          systemRole: null,
          label: "Custom",
          description: "",
          sortOrder: 1,
          overviewLevel: levels.overview ?? "NONE",
          bookingsLevel: levels.bookings ?? "NONE",
          membershipLevel: levels.membership ?? "NONE",
          financeLevel: levels.finance ?? "NONE",
          lodgeLevel: levels.lodge ?? "NONE",
          contentLevel: levels.content ?? "NONE",
          supportLevel: levels.support ?? "NONE",
        },
      },
    ],
  };
}

const FULL_ADMIN = actorWith({
  overview: "EDIT",
  bookings: "EDIT",
  membership: "EDIT",
  finance: "EDIT",
  lodge: "EDIT",
  content: "EDIT",
  support: "EDIT",
});

const BOOKINGS_ONLY = actorWith({ bookings: "VIEW" });

const BOOKING_ROW = {
  status: "CONFIRMED",
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-04T00:00:00.000Z"),
  createdAt: new Date("2026-06-01T02:03:04.000Z"),
  deletedAt: null,
  requiresAdminReview: false,
  adminReviewStatus: null,
  notes: "Late arrival",
  lodge: { name: "Alpine Lodge" },
  member: { firstName: "Ada", lastName: "Lovelace" },
  _count: { guests: 2 },
};

const MEMBER_ROW = {
  active: true,
  canLogin: true,
  emailVerified: true,
  ageTier: "ADULT",
  createdAt: new Date("2026-01-05T00:00:00.000Z"),
  firstName: "Grace",
  lastName: "Hopper",
};

function resolve(selector: unknown, actingMemberId = ACTOR) {
  return resolveDiagnosticsPageContext({
    selector,
    actingMemberId,
    observedAt: OBSERVED_AT,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberFindUnique.mockResolvedValue(FULL_ADMIN);
  mocks.bookingFindUnique.mockResolvedValue(BOOKING_ROW);
  mocks.paymentFindUnique.mockResolvedValue(null);
});

describe("fail-closed inputs", () => {
  it("returns unavailable/invalid_selector for a malformed selector and reads nothing", async () => {
    const result = await resolve({ routeKey: "admin.bookings", nope: 1 });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("invalid_selector");
    expect(result.route).toBeNull();
    expect(result.record).toBeNull();
    expect(result.audit.authOutcome).toBe("denied");
    // No permission read and no projection read happen for junk input.
    expect(mocks.memberFindUnique).not.toHaveBeenCalled();
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });

  it("returns unavailable/unknown_route for an unregistered page", async () => {
    const result = await resolve({ routeKey: "admin.secret-page" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("unknown_route");
    expect(result.route).toBeNull();
  });

  it("denies when the acting member cannot be resolved", async () => {
    mocks.memberFindUnique.mockResolvedValue(null);
    const result = await resolve({ routeKey: "admin.bookings" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("actor_unresolved");
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });

  it("denies when the permission read itself fails — never an empty-matrix pass", async () => {
    mocks.memberFindUnique.mockRejectedValue(new Error("db down"));
    const result = await resolve({ routeKey: "admin.bookings" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("actor_unresolved");
  });

  it("returns unavailable/lookup_failed — not an empty record — when the projection throws", async () => {
    mocks.bookingFindUnique.mockRejectedValue(new Error("timeout"));
    const result = await resolve({
      routeKey: "admin.bookings",
      recordId: "cbk1",
    });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("lookup_failed");
    expect(result.record).toBeNull();
    // The permission check passed; only the read failed. Auditing this as a
    // denial would invent a permission incident that never happened.
    expect(result.audit.authOutcome).toBe("allowed");
    expect(result.audit.routeKey).toBe("admin.bookings");
  });
});

describe("fresh, fail-closed authorization (ADR-002)", () => {
  it("re-reads the caller's roles from the database on EVERY resolution", async () => {
    await resolve({ routeKey: "admin.bookings" });
    await resolve({ routeKey: "admin.bookings" });
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(2);
    expect(mocks.memberFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ACTOR } }),
    );
  });

  it("never derives the matrix from a session-carried snapshot", async () => {
    await resolve({ routeKey: "admin.bookings" });
    const select = mocks.memberFindUnique.mock.calls[0][0].select;
    expect(select).toHaveProperty("accessRoles");
    expect(select).toHaveProperty("canLogin");
    expect(select).not.toHaveProperty("adminPermissionMatrix");
  });

  it("honours a role revoked mid-session on the very next call", async () => {
    const first = await resolve({ routeKey: "admin.payments" });
    expect(first.status).toBe("resolved");

    // The treasurer's finance role is revoked between questions.
    mocks.memberFindUnique.mockResolvedValue(BOOKINGS_ONLY);
    const second = await resolve({ routeKey: "admin.payments" });
    expect(second.status).toBe("denied");
    expect(second.reason).toBe("permission_denied");
    expect(second.record).toBeNull();
  });

  it("denies a deactivated account even while its roles still exist", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      ...FULL_ADMIN,
      canLogin: false,
    });
    const result = await resolve({ routeKey: "admin.bookings" });
    expect(result.status).toBe("denied");
  });

  it("requires EVERY area on a cross-area page (AND, never OR)", async () => {
    // Bed allocation needs bookings AND lodge; a bookings-only admin is denied.
    mocks.memberFindUnique.mockResolvedValue(BOOKINGS_ONLY);
    const denied = await resolve({ routeKey: "admin.bed-allocation" });
    expect(denied.status).toBe("denied");
    expect(denied.omissions.map((o) => o.area)).toEqual(["lodge"]);
    expect(denied.omissions[0].message).toContain("Lodge Operations");

    mocks.memberFindUnique.mockResolvedValue(
      actorWith({ bookings: "VIEW", lodge: "VIEW" }),
    );
    const allowed = await resolve({ routeKey: "admin.bed-allocation" });
    expect(allowed.status).toBe("resolved");
  });

  it("names the missing area in the denial so the answer can say what is omitted", async () => {
    mocks.memberFindUnique.mockResolvedValue(BOOKINGS_ONLY);
    const result = await resolve({ routeKey: "admin.payments" });
    expect(result.omissions).toEqual([
      expect.objectContaining({ code: "permission_denied", area: "finance" }),
    ]);
    expect(result.route?.key).toBe("admin.payments");
    expect(result.record).toBeNull();
    expect(result.audit.authOutcome).toBe("denied");
  });
});

describe("IDOR and record-kind substitution", () => {
  it("never lets the client choose the record KIND — only the id", async () => {
    // A member id supplied on a bookings page is looked up as a BOOKING.
    await resolve({ routeKey: "admin.bookings", recordId: "cmember1" });
    expect(mocks.bookingFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cmember1" } }),
    );
    // The member delegate is used only for the actor's own permission read.
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.memberFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ACTOR } }),
    );
  });

  it("refuses to re-fetch a member record for a bookings-only admin", async () => {
    mocks.memberFindUnique.mockResolvedValue(BOOKINGS_ONLY);
    const result = await resolve({
      routeKey: "admin.member-detail",
      recordId: "cmember1",
    });
    expect(result.status).toBe("denied");
    // The permission read happened; the RECORD read did not.
    expect(mocks.memberFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.memberFindUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cmember1" } }),
    );
  });

  it("reports record_not_found as an omission, not as invented facts", async () => {
    mocks.bookingFindUnique.mockResolvedValue(null);
    const result = await resolve({
      routeKey: "admin.bookings",
      recordId: "cmissing",
    });
    expect(result.status).toBe("resolved");
    expect(result.record).toBeNull();
    expect(result.omissions).toEqual([
      expect.objectContaining({ code: "record_not_found" }),
    ]);
    expect(result.audit.recordRefHash).toBeNull();
  });

  it("reads a restricted projection — never the whole row", async () => {
    await resolve({ routeKey: "admin.bookings", recordId: "cbk1" });
    const select = mocks.bookingFindUnique.mock.calls[0][0].select;
    expect(select).toBeDefined();
    // Money, member ids, review notes and the credit election are all outside
    // the page-context projection; a finance question belongs to AID-6C.
    for (const forbidden of [
      "finalPriceCents",
      "totalPriceCents",
      "memberId",
      "adminReviewNotes",
      "creditElectionCents",
    ]) {
      expect(select).not.toHaveProperty(forbidden);
    }
  });
});

describe("sensitive record context is opt-in (ADR-004 §1)", () => {
  it("withholds identifying fields by default and says so", async () => {
    const result = await resolve({
      routeKey: "admin.bookings",
      recordId: "cbk1",
    });
    expect(result.record?.sensitiveIncluded).toBe(false);
    expect(result.record?.facts.some((f) => f.sensitive)).toBe(false);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Ada");
    expect(serialized).not.toContain("Lovelace");
    expect(serialized).not.toContain("Late arrival");

    expect(result.omissions).toEqual([
      {
        code: "sensitive_opt_out",
        message: DIAGNOSTICS_SENSITIVE_INCLUSION_COPY.omittedNotice,
      },
    ]);
  });

  it("still returns the non-identifying state so the answer is useful", async () => {
    const result = await resolve({
      routeKey: "admin.bookings",
      recordId: "cbk1",
    });
    const byKey = Object.fromEntries(
      (result.record?.facts ?? []).map((f) => [f.key, f.value]),
    );
    expect(byKey["booking.status"]).toBe("CONFIRMED");
    expect(byKey["booking.check-in"]).toBe("2026-08-01");
    expect(byKey["booking.check-out"]).toBe("2026-08-04");
    expect(byKey["booking.nights"]).toBe("3");
    expect(byKey["booking.guest-count"]).toBe("2");
    expect(byKey["booking.lodge"]).toBe("Alpine Lodge");
  });

  it("includes identifying fields ONLY on an explicit per-record opt-in", async () => {
    const result = await resolve({
      routeKey: "admin.bookings",
      recordId: "cbk1",
      includeSensitiveRecord: true,
    });
    expect(result.record?.sensitiveIncluded).toBe(true);
    const sensitive = (result.record?.facts ?? []).filter((f) => f.sensitive);
    expect(sensitive.map((f) => f.key)).toEqual([
      "booking.member-name",
      "booking.notes",
    ]);
    expect(sensitive[0].value).toBe("Ada Lovelace");
    expect(
      result.omissions.some((o) => o.code === "sensitive_opt_out"),
    ).toBe(false);
  });

  it("does not project a member's contact details at any opt-in level", async () => {
    mocks.memberFindUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        args.where.id === ACTOR ? FULL_ADMIN : MEMBER_ROW,
    );
    const result = await resolve({
      routeKey: "admin.member-detail",
      recordId: "cmember1",
      includeSensitiveRecord: true,
    });
    const keys = (result.record?.facts ?? []).map((f) => f.key);
    expect(keys).toContain("member.name");
    expect(keys).not.toContain("member.email");
    expect(keys).not.toContain("member.phone");
    const select = mocks.memberFindUnique.mock.calls[1][0].select;
    expect(select).not.toHaveProperty("email");
    expect(select).not.toHaveProperty("phoneNumber");
    expect(select).not.toHaveProperty("passwordHash");
  });
});

describe("redaction and logging discipline (ADR-004 §2/§4)", () => {
  it("redacts a secret pasted into a booking note before it can travel", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      ...BOOKING_ROW,
      notes: "api_key: sk-ant-super-secret-value",
    });
    const result = await resolve({
      routeKey: "admin.bookings",
      recordId: "cbk1",
      includeSensitiveRecord: true,
    });
    expect(JSON.stringify(result)).not.toContain("sk-ant-super-secret-value");
  });

  it("bounds an overlong free-text fact rather than shipping it whole", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      ...BOOKING_ROW,
      notes: "z".repeat(5000),
    });
    const result = await resolve({
      routeKey: "admin.bookings",
      recordId: "cbk1",
      includeSensitiveRecord: true,
    });
    const notes = result.record?.facts.find((f) => f.key === "booking.notes");
    expect(notes?.value.length).toBeLessThanOrEqual(200);
  });

  it("redacts a token pasted into a filter value", async () => {
    const result = await resolve({
      routeKey: "admin.bookings",
      filters: { search: "api_key=sk-live-abcdef123456" },
    });
    expect(JSON.stringify(result.selection)).not.toContain(
      "sk-live-abcdef123456",
    );
  });

  it("keeps the audit metadata to the approved set — a hash, never the raw id", async () => {
    const result = await resolve({
      routeKey: "admin.bookings",
      recordId: "cbk1",
      includeSensitiveRecord: true,
    });
    expect(Object.keys(result.audit).sort()).toEqual([
      "areasChecked",
      "authOutcome",
      "byteCount",
      "factCount",
      "observedAt",
      "recordKind",
      "recordRefHash",
      "routeKey",
    ]);
    expect(result.audit.recordRefHash).toMatch(/^[0-9a-f]{64}$/);
    const auditJson = JSON.stringify(result.audit);
    expect(auditJson).not.toContain("cbk1");
    expect(auditJson).not.toContain("Ada");
    expect(auditJson).not.toContain("Alpine Lodge");
    expect(result.audit.factCount).toBe(result.record?.facts.length);
    expect(result.audit.byteCount).toBeGreaterThan(0);
  });

  it("hashes the record reference with the KIND, so ids cannot collide across kinds", async () => {
    const booking = await resolve({
      routeKey: "admin.bookings",
      recordId: "shared-id",
    });
    mocks.memberFindUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        args.where.id === ACTOR ? FULL_ADMIN : MEMBER_ROW,
    );
    const member = await resolve({
      routeKey: "admin.member-detail",
      recordId: "shared-id",
    });
    expect(booking.audit.recordRefHash).not.toBe(member.audit.recordRefHash);
  });
});

describe("observed-at and citation (ADR-003 §3)", () => {
  it("stamps the resolution and the record with the observed-at instant", async () => {
    const result = await resolve({
      routeKey: "admin.bookings",
      recordId: "cbk1",
    });
    expect(result.observedAt).toBe(OBSERVED_AT.toISOString());
    expect(result.record?.observedAt).toBe(OBSERVED_AT.toISOString());
    expect(result.audit.observedAt).toBe(OBSERVED_AT.toISOString());
  });

  it("echoes the SERVER's route identity, never a client-supplied pathname", async () => {
    const result = await resolve({ routeKey: "admin.bookings" });
    expect(result.route).toEqual({
      key: "admin.bookings",
      pathname: "/admin/bookings",
      label: "Bookings list",
    });
  });
});

describe("route switching", () => {
  it("re-authorizes and re-reads for the new route, carrying nothing over", async () => {
    mocks.memberFindUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        args.where.id === ACTOR ? FULL_ADMIN : MEMBER_ROW,
    );

    const onBookings = await resolve({
      routeKey: "admin.bookings",
      recordId: "cbk1",
    });
    expect(onBookings.record?.kind).toBe("booking");

    const onMembers = await resolve({
      routeKey: "admin.member-detail",
      recordId: "cmember1",
      tab: "audit-log",
    });
    expect(onMembers.record?.kind).toBe("member");
    expect(onMembers.selection.tab).toBe("audit-log");
    expect(onMembers.audit.areasChecked).toEqual(["membership"]);
    // Nothing from the bookings resolution survives into the members one.
    expect(JSON.stringify(onMembers)).not.toContain("Alpine Lodge");
    expect(onMembers.record?.facts.every((f) => f.key.startsWith("member."))).toBe(
      true,
    );
  });

  it("drops a selection the new route does not allow, by refusing the selector", async () => {
    // The tab is valid on member-detail but not on the bookings list, so the
    // same tab token on the wrong route is a rejection, not a carried-over view.
    const result = await resolve({
      routeKey: "admin.bookings",
      tab: "audit-log",
    });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("invalid_selector");
  });
});
