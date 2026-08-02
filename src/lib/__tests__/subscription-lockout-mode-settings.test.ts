import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three-way subscription-lockout SETTING (#2543): how it is stored, how a
 * null resolves, and how the club-wide mode is derived.
 *
 * The single most important property under test is that NOTHING MOVED. The
 * migration adds `mode` without a backfill, so on the release that ships #2543
 * every club's row holds `mode = null` and the legacy `enabled` boolean is what
 * decides their policy. A club that had deliberately switched the lockout off
 * must still be off; a club that had it on must still hard-block. Money and
 * booking access both hang off this, so each direction has its own case.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  refreshFinancialYearConfig: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { membershipLockoutSettings: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("@/lib/financial-year-server", () => ({
  refreshFinancialYearConfig: mocks.refreshFinancialYearConfig,
}));

import {
  SUBSCRIPTION_LOCKOUT_MODES,
  isSubscriptionLockoutMode,
  legacyEnabledForLockoutMode,
  loadMembershipLockoutSettings,
  normalizeMembershipLockoutSettings,
} from "@/lib/membership-lockout-settings";
import {
  isSubscriptionEnforcementActive,
  peekSubscriptionLockoutMode,
  resolveSubscriptionLockoutMode,
} from "@/lib/member-subscription-eligibility";

/** A row as it exists on the release that ships #2543: `mode` not yet chosen. */
function unmigratedRow(enabled: boolean) {
  return {
    id: "default",
    mode: null,
    enabled,
    financialYearEndMonthOverride: null,
    textFallbackEnabled: true,
    useFeeScheduleItemCodes: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: true });
  mocks.refreshFinancialYearConfig.mockResolvedValue(3);
  mocks.findUnique.mockResolvedValue(null);
});

describe("the three-way vocabulary is closed (#2543)", () => {
  it("is exactly three mutually exclusive answers", () => {
    expect(SUBSCRIPTION_LOCKOUT_MODES).toEqual([
      "NO_BLOCK",
      "HARD_BLOCK",
      "NON_MEMBER_PRICING",
    ]);
    expect(new Set(SUBSCRIPTION_LOCKOUT_MODES).size).toBe(3);
  });

  it("recognises only those three", () => {
    for (const mode of SUBSCRIPTION_LOCKOUT_MODES) {
      expect(isSubscriptionLockoutMode(mode)).toBe(true);
    }
    for (const notAMode of [
      "MAYBE_BLOCK",
      "hard_block",
      "",
      null,
      undefined,
      true,
      1,
      {},
    ]) {
      expect(isSubscriptionLockoutMode(notAMode)).toBe(false);
    }
  });
});

describe("normalizeMembershipLockoutSettings resolves the stored mode (#2543)", () => {
  it("a chosen mode wins", () => {
    expect(
      normalizeMembershipLockoutSettings({ mode: "NON_MEMBER_PRICING" }).mode,
    ).toBe("NON_MEMBER_PRICING");
  });

  // THE case this ladder exists for. Regression guard: resolving a null `mode`
  // straight to the HARD_BLOCK default would silently switch the lockout back ON
  // for every club that had turned it off.
  it("a null mode falls back to the legacy boolean: false -> NO_BLOCK", () => {
    expect(normalizeMembershipLockoutSettings(unmigratedRow(false)).mode).toBe(
      "NO_BLOCK",
    );
  });

  it("a null mode falls back to the legacy boolean: true -> HARD_BLOCK", () => {
    expect(normalizeMembershipLockoutSettings(unmigratedRow(true)).mode).toBe(
      "HARD_BLOCK",
    );
  });

  it("a chosen mode beats a stale legacy boolean", () => {
    // A draining old colour can still write `enabled`, so the two columns can
    // disagree. `mode` is the authority once it is set.
    expect(
      normalizeMembershipLockoutSettings({
        mode: "NON_MEMBER_PRICING",
        enabled: false,
      }).mode,
    ).toBe("NON_MEMBER_PRICING");
  });

  it("an unrecognised mode string is not trusted; it re-enters the ladder", () => {
    // A hand-edited config bundle cannot invent a fourth policy.
    expect(
      normalizeMembershipLockoutSettings({ mode: "SOMETIMES", enabled: false })
        .mode,
    ).toBe("NO_BLOCK");
    expect(normalizeMembershipLockoutSettings({ mode: "SOMETIMES" }).mode).toBe(
      "HARD_BLOCK",
    );
  });

  it("no row at all is HARD_BLOCK — a fresh install starts where clubs already were", () => {
    expect(normalizeMembershipLockoutSettings(null).mode).toBe("HARD_BLOCK");
    expect(normalizeMembershipLockoutSettings(undefined).mode).toBe("HARD_BLOCK");
    expect(normalizeMembershipLockoutSettings({}).mode).toBe("HARD_BLOCK");
  });

  it("does not leak the legacy column into the resolved settings", () => {
    // Application code must read `mode`. A lingering `enabled` on the resolved
    // shape is an invitation for a caller to branch on the wrong one.
    expect(
      normalizeMembershipLockoutSettings(unmigratedRow(true)),
    ).not.toHaveProperty("enabled");
  });
});

describe("legacyEnabledForLockoutMode keeps the dropped-later column truthful (#2543)", () => {
  it.each([
    ["NO_BLOCK", false],
    ["HARD_BLOCK", true],
    // NON_MEMBER_PRICING maps to the old hard block deliberately: old code cannot
    // reprice, so if a club is rolled back onto it, refusing an unpaid member is
    // honest, whereas `false` would hand them full member rates — the one outcome
    // the club has explicitly decided against.
    ["NON_MEMBER_PRICING", true],
  ] as const)("%s -> enabled=%s", (mode, expected) => {
    expect(legacyEnabledForLockoutMode(mode)).toBe(expected);
  });

  it("round-trips every mode that the boolean can represent", () => {
    for (const mode of ["NO_BLOCK", "HARD_BLOCK"] as const) {
      expect(
        normalizeMembershipLockoutSettings({
          mode: null,
          enabled: legacyEnabledForLockoutMode(mode),
        }).mode,
      ).toBe(mode);
    }
  });
});

describe("resolveSubscriptionLockoutMode (#2543)", () => {
  it.each(SUBSCRIPTION_LOCKOUT_MODES)("returns the stored %s", async (mode) => {
    mocks.findUnique.mockResolvedValue({ ...unmigratedRow(true), mode });
    await expect(resolveSubscriptionLockoutMode()).resolves.toBe(mode);
  });

  it("resolves NO_BLOCK whenever the Xero module is effectively off", async () => {
    // Subscriptions are invoiced through Xero, so with the module off nobody can
    // ever reach PAID. Neither refusing them nor repricing them would be honest.
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: false });
    mocks.findUnique.mockResolvedValue({
      ...unmigratedRow(true),
      mode: "NON_MEMBER_PRICING",
    });

    await expect(resolveSubscriptionLockoutMode()).resolves.toBe("NO_BLOCK");
    // Not even read: the module flag short-circuits first.
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  /**
   * THE RESEED IS GATED ON THE XERO MODULE, NOT ON THE MODE, and that is the
   * pre-#2543 condition restored. Every request-path reseeder in the tree routes
   * through this function (the booking write paths, `findUnpaidMemberGuests`, the
   * member notice builder), so gating it on `mode !== "NO_BLOCK"` left a club that
   * has deliberately switched the lockout OFF — with Xero still on — without a
   * request-path reseed at all. After a container restart, `getSeasonYear` and
   * `computeAgeTier` then resolve against the module-level March default instead of
   * the club's real year-end month, and the rate resolved for a booking can differ
   * from the correct one. `NO_BLOCK` is exactly what an existing club with
   * `enabled = false` resolves to through the legacy fallback, so this is the
   * ordinary case, not an exotic one.
   */
  it.each(["HARD_BLOCK", "NON_MEMBER_PRICING", "NO_BLOCK"] as const)(
    "reseeds the financial-year cache with Xero on, in %s",
    async (mode) => {
      mocks.findUnique.mockResolvedValue({ ...unmigratedRow(true), mode });
      await resolveSubscriptionLockoutMode();
      expect(mocks.refreshFinancialYearConfig).toHaveBeenCalledTimes(1);
    },
  );

  it("reseeds for a club whose LEGACY boolean resolves NO_BLOCK", async () => {
    // The un-backfilled row every existing club has on this release: mode null,
    // enabled false. This is the case the narrowed gate silently dropped.
    mocks.findUnique.mockResolvedValue(unmigratedRow(false));
    await expect(resolveSubscriptionLockoutMode()).resolves.toBe("NO_BLOCK");
    expect(mocks.refreshFinancialYearConfig).toHaveBeenCalledTimes(1);
  });

  it("does NOT reseed when the Xero module is off", async () => {
    // Nothing to reseed from: the financial year follows the connected Xero org
    // unless an admin overrides it, and with the module off there is no gate either.
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: false });
    await resolveSubscriptionLockoutMode();
    expect(mocks.refreshFinancialYearConfig).not.toHaveBeenCalled();
  });
});

describe("peekSubscriptionLockoutMode is the in-transaction reader (#2543)", () => {
  // The distinction is not micro-optimisation. `refreshFinancialYearConfig` can
  // reach Xero for the organisation's accounting year, and the pricing gate that
  // calls `peek` runs inside booking transactions holding the per-lodge capacity
  // lock. A provider call in there is the one thing the booking rules forbid
  // outright, so the in-transaction reader must not be able to make one.
  it("never reseeds the financial-year cache", async () => {
    mocks.findUnique.mockResolvedValue({
      ...unmigratedRow(true),
      mode: "NON_MEMBER_PRICING",
    });

    await expect(peekSubscriptionLockoutMode()).resolves.toBe(
      "NON_MEMBER_PRICING",
    );
    expect(mocks.refreshFinancialYearConfig).not.toHaveBeenCalled();
  });

  it("agrees with resolveSubscriptionLockoutMode on every input", async () => {
    for (const mode of SUBSCRIPTION_LOCKOUT_MODES) {
      mocks.findUnique.mockResolvedValue({ ...unmigratedRow(true), mode });
      expect(await peekSubscriptionLockoutMode()).toBe(
        await resolveSubscriptionLockoutMode(),
      );
    }
  });
});

describe("isSubscriptionEnforcementActive spans both enforcing modes (#2543)", () => {
  // Kept mode-blind on purpose: HARD_BLOCK and NON_MEMBER_PRICING need the same
  // underlying fact ("this member owes a paid subscription"), and differ only in
  // what they do with it. That is what lets one gate compute both regimes.
  it.each([
    ["NO_BLOCK", false],
    ["HARD_BLOCK", true],
    ["NON_MEMBER_PRICING", true],
  ] as const)("%s -> %s", async (mode, expected) => {
    mocks.findUnique.mockResolvedValue({ ...unmigratedRow(true), mode });
    await expect(isSubscriptionEnforcementActive()).resolves.toBe(expected);
  });
});

describe("loadMembershipLockoutSettings tolerates a missing table", () => {
  it("falls back to defaults rather than failing a booking request", async () => {
    mocks.findUnique.mockRejectedValue(new Error("relation does not exist"));
    await expect(loadMembershipLockoutSettings()).resolves.toMatchObject({
      mode: "HARD_BLOCK",
    });
  });
});
