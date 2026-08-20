import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isEffectiveModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: mocks.isEffectiveModuleEnabled,
}));
vi.mock("@/lib/bed-allocation-admin-contract", () => ({
  BedAllocationAdminError: class BedAllocationAdminError extends Error {},
}));
vi.mock("@/lib/bed-allocation-settings", () => ({
  BedAllocationSettingsValidationError:
    class BedAllocationSettingsValidationError extends Error {},
}));

import {
  requireBedAllocationRead,
  requireBedAllocationWrite,
  requireBedInventoryRead,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";

const session = { user: { id: "admin-1" } };

describe("bed-allocation route permission helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session });
    mocks.isEffectiveModuleEnabled.mockResolvedValue(true);
  });

  it.each([
    ["allocation read", requireBedAllocationRead, "view"],
    ["inventory read", requireBedInventoryRead, "view"],
    ["allocation write", requireBedAllocationWrite, "edit"],
    ["inventory write", requireBedInventoryWrite, "edit"],
  ] as const)("pins %s to its bookings permission", async (_name, guard, level) => {
    await expect(guard()).resolves.toEqual({ ok: true, session });

    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level },
    });
    expect(mocks.isEffectiveModuleEnabled).toHaveBeenCalledWith(
      "bedAllocation",
    );
  });
});
