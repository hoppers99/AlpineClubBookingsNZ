// "+ Add Member Guest" (epic #2305) MG1 (#2306) — the policy singleton is read
// lazily and never materialised by a read.
//
// The migration seeds no row on purpose (a seed would be DML the blue/green
// validator hard-blocks), so "the club has never opened these settings" is the
// normal state on every install until MG2 ships the settings card. This file
// pins that a read in that state answers with the shipped defaults and writes
// nothing at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { memberGuestSettings: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

const loggerError = vi.fn();
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => loggerError(...a) },
}));

import {
  MEMBER_GUEST_SETTINGS_ID,
  loadMemberGuestSettings,
} from "@/lib/member-guest-settings";
import { DEFAULT_MEMBER_GUEST_SETTINGS } from "@/config/club-settings-defaults";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadMemberGuestSettings", () => {
  it("reads the singleton by its fixed id", async () => {
    findUnique.mockResolvedValue(null);
    await loadMemberGuestSettings();
    expect(MEMBER_GUEST_SETTINGS_ID).toBe("default");
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "default" } });
  });

  it("answers with the shipped defaults on a club that never saved the row", async () => {
    findUnique.mockResolvedValue(null);
    await expect(loadMemberGuestSettings()).resolves.toEqual({
      approvalRequired: true,
      pendingHoldExpiryDays: 7,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
    });
  });

  it("creates nothing while answering", async () => {
    // Lazy means lazy: a read must not plant a row. Materialising singletons is
    // observable — several setup-readiness signals key on row existence — so a
    // read that quietly upserts would change the setup checklist.
    findUnique.mockResolvedValue(null);
    await loadMemberGuestSettings();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("returns a saved row's values", async () => {
    findUnique.mockResolvedValue({
      approvalRequired: false,
      pendingHoldExpiryDays: 21,
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: true,
      updatedAt: new Date("2026-07-31T00:00:00.000Z"),
      updatedByMemberId: "m-admin",
    });
    await expect(loadMemberGuestSettings()).resolves.toEqual({
      approvalRequired: false,
      pendingHoldExpiryDays: 21,
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: true,
    });
  });

  it("falls back to the defaults if the table is missing mid-deploy", async () => {
    // During a blue/green window the old colour can be running against a schema
    // that predates the table. A booking flow must not 500 over an inert
    // policy row it does not even use yet.
    findUnique.mockRejectedValue(new Error("relation \"MemberGuestSettings\" does not exist"));
    await expect(loadMemberGuestSettings()).resolves.toEqual({
      ...DEFAULT_MEMBER_GUEST_SETTINGS,
    });
    expect(loggerError).toHaveBeenCalled();
  });
});
