import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-focused test for the membership-lockout-settings route (#1940). Mirrors
// the fee-configuration-route pattern: mock `requireAdmin` so we can assert the
// exact per-area permission each verb requires and that a denial short-circuits
// with 403 before any write.
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  auditLogCreate: vi.fn(),
  getFinancialYearResolution: vi.fn(),
  refreshFinancialYearConfig: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipLockoutSettings: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
    auditLog: { create: mocks.auditLogCreate },
  },
}));

vi.mock("@/lib/financial-year-server", () => ({
  getFinancialYearResolution: mocks.getFinancialYearResolution,
  refreshFinancialYearConfig: mocks.refreshFinancialYearConfig,
}));

import {
  GET as getLockoutSettings,
  PUT as putLockoutSettings,
} from "@/app/api/admin/membership-lockout-settings/route";

const session = {
  user: {
    id: "admin-1",
    // Finance view is required for the fee-schedule preview (#2109 FIX-4b); the
    // default session holds it so the preview assertions below see the code
    // lists. A finance-less admin is covered by its own case.
    adminPermissionMatrix: { membership: "edit", finance: "view" },
  },
};

function request(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/membership-lockout-settings",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("membership lockout settings route guards (#1940)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({
      id: "default",
      enabled: true,
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: false,
    });
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.getFinancialYearResolution.mockResolvedValue({});
    mocks.refreshFinancialYearConfig.mockResolvedValue(3);
  });

  it("requires membership view for reads", async () => {
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response: forbidden });

    expect((await getLockoutSettings()).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "membership", level: "view" },
    });
  });

  it("requires membership edit before parsing writes", async () => {
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response: forbidden });

    // A denied write is rejected before the body is ever parsed/persisted.
    expect(
      (await putLockoutSettings(request({ mode: "NO_BLOCK" }))).status,
    ).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "membership", level: "edit" },
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("persists the update for a membership edit admin", async () => {
    const response = await putLockoutSettings(request({ mode: "NO_BLOCK" }));

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // #2543 — the three-way mode replaces the boolean, and writes both columns.
  // ---------------------------------------------------------------------------

  it.each([
    ["NO_BLOCK", false],
    ["HARD_BLOCK", true],
    ["NON_MEMBER_PRICING", true],
  ] as const)(
    "persists mode %s and keeps the legacy enabled column in step (%s)",
    async (mode, expectedEnabled) => {
      const response = await putLockoutSettings(request({ mode }));

      expect(response.status).toBe(200);
      const upsertArgs = mocks.upsert.mock.calls[0][0];
      // Both columns, every save: `enabled` is not dropped until a later contract
      // release, so a draining old colour must keep finding a truthful value.
      expect(upsertArgs.update).toEqual(
        expect.objectContaining({ mode, enabled: expectedEnabled }),
      );
      expect(upsertArgs.create).toEqual(
        expect.objectContaining({ mode, enabled: expectedEnabled }),
      );
    },
  );

  it("refuses a legacy `enabled` body rather than silently ignoring it", async () => {
    // The schema is .strict(). A silent ignore is the dangerous direction: an old
    // client's "turn the lockout off" click would report success while the club
    // carried on hard-blocking members.
    const response = await putLockoutSettings(request({ enabled: false }));

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a mode outside the three-way vocabulary", async () => {
    const response = await putLockoutSettings(request({ mode: "MAYBE_BLOCK" }));

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("an unrelated field save reads an un-migrated row's mode through the legacy boolean", async () => {
    // The row predates #2543: `mode` is null, `enabled` is false (this club
    // deliberately switched the lockout OFF). Saving a DIFFERENT field must not
    // resurrect the lockout — the regression this case exists to catch is
    // `before.mode ?? "HARD_BLOCK"`, which would.
    mocks.findUnique.mockResolvedValue({
      id: "default",
      mode: null,
      enabled: false,
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: false,
    });

    const response = await putLockoutSettings(
      request({ useFeeScheduleItemCodes: true }),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update).toEqual(
      expect.objectContaining({ mode: "NO_BLOCK", enabled: false }),
    );
  });

  it("accepts and persists useFeeScheduleItemCodes (#2109)", async () => {
    const response = await putLockoutSettings(
      request({ useFeeScheduleItemCodes: true }),
    );

    expect(response.status).toBe(200);
    const upsertArgs = mocks.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual(
      expect.objectContaining({ useFeeScheduleItemCodes: true }),
    );
    expect(upsertArgs.create).toEqual(
      expect.objectContaining({ useFeeScheduleItemCodes: true }),
    );
  });

  it("rejects an unknown field via the strict schema", async () => {
    const response = await putLockoutSettings(request({ bogusField: true }));
    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("GET returns the fee-schedule detection preview for a finance-view admin (#2109)", async () => {
    const response = await getLockoutSettings();
    expect(response.status).toBe(200);
    const body = await response.json();
    // The resolver/overlap reads degrade to [] under the route's minimal prisma
    // mock, but the preview keys are present for a finance-view admin.
    expect(body).toEqual(
      expect.objectContaining({
        feeScheduleItemCodes: expect.any(Array),
        overlappingCodes: expect.any(Array),
      }),
    );
  });

  it("GET omits the fee-schedule preview for an admin without finance view (#2109 FIX-4b)", async () => {
    // A membership-only admin gets the settings without the finance-domain code
    // lists; the panel hides the detection card for them and defaults to [].
    mocks.requireAdmin.mockResolvedValueOnce({
      ok: true,
      session: {
        user: { id: "admin-1", adminPermissionMatrix: { membership: "edit" } },
      },
    });

    const response = await getLockoutSettings();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings).toBeDefined();
    expect(body.feeScheduleItemCodes).toBeUndefined();
    expect(body.overlappingCodes).toBeUndefined();
  });
});
