import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The maintenance-report policy singleton (#2780).
 *
 * THE SUBJECT IS THAT EVERY FAILURE PATH IS CLOSED. A missing row, a table that
 * does not exist yet during a blue/green window, and a database error must all
 * resolve to `DEFAULT_MAINTENANCE_REPORT_SETTINGS`, in which
 * `anonymousReportsEnabled` is `false`. So an outage can only ever close the
 * unauthenticated door, never open it.
 *
 * The clock is frozen at 2026-07-01T00:00:00.000Z by the shared harness, so the
 * expiry arithmetic below is written against that instant and stays correct.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    maintenanceReportSettings: {
      findUnique: mocks.findUnique,
      create: mocks.create,
      upsert: mocks.upsert,
      update: mocks.update,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
  },
}));

import {
  DEFAULT_MAINTENANCE_REPORT_SETTINGS,
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX,
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN,
} from "@/config/club-settings-defaults";
import {
  MAINTENANCE_REPORT_SETTINGS_ID,
  clampPhotoRetentionDays,
  getMaintenancePhotoExpiresAt,
  loadMaintenanceReportSettings,
  normalizeMaintenanceReportSettings,
} from "@/lib/maintenance-report-settings";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The frozen instant every unit test file runs at. */
const FROZEN_NOW = new Date("2026-07-01T00:00:00.000Z");

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MAINTENANCE_REPORT_SETTINGS_ID,
    anonymousReportsEnabled: true,
    photosEnabled: true,
    anonymousPhotosEnabled: true,
    photoRetentionDays: 30,
    anonymousContactPrompt: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the shipped defaults are fail-closed", () => {
  it("ships anonymous reports OFF", () => {
    // The one default that decides whether an unauthenticated endpoint answers.
    expect(DEFAULT_MAINTENANCE_REPORT_SETTINGS.anonymousReportsEnabled).toBe(false);
  });

  it("ships a retention window inside its own bounds", () => {
    expect(DEFAULT_MAINTENANCE_REPORT_SETTINGS.photoRetentionDays).toBeGreaterThanOrEqual(
      MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN,
    );
    expect(DEFAULT_MAINTENANCE_REPORT_SETTINGS.photoRetentionDays).toBeLessThanOrEqual(
      MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX,
    );
  });
});

describe("loadMaintenanceReportSettings", () => {
  it("reads the single 'default' row", async () => {
    mocks.findUnique.mockResolvedValue(storedRow());

    await loadMaintenanceReportSettings();

    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: MAINTENANCE_REPORT_SETTINGS_ID },
    });
  });

  it("returns the stored values when a row exists", async () => {
    mocks.findUnique.mockResolvedValue(
      storedRow({
        anonymousReportsEnabled: true,
        photosEnabled: false,
        anonymousPhotosEnabled: false,
        photoRetentionDays: 7,
        anonymousContactPrompt: false,
      }),
    );

    await expect(loadMaintenanceReportSettings()).resolves.toEqual({
      anonymousReportsEnabled: true,
      photosEnabled: false,
      anonymousPhotosEnabled: false,
      photoRetentionDays: 7,
      anonymousContactPrompt: false,
    });
  });

  it("falls back to the closed defaults when no row has ever been written", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const settings = await loadMaintenanceReportSettings();

    expect(settings.anonymousReportsEnabled).toBe(false);
    expect(settings).toEqual({ ...DEFAULT_MAINTENANCE_REPORT_SETTINGS });
  });

  it("writes NOTHING on the read path — the row is created lazily by the admin save", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await loadMaintenanceReportSettings();

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the database errors, and says so in the log", async () => {
    // A missing table during a blue/green window looks exactly like this.
    mocks.findUnique.mockRejectedValue(new Error("relation does not exist"));

    const settings = await loadMaintenanceReportSettings();

    expect(settings.anonymousReportsEnabled).toBe(false);
    expect(settings).toEqual({ ...DEFAULT_MAINTENANCE_REPORT_SETTINGS });
    expect(mocks.loggerError).toHaveBeenCalledOnce();
  });

  it("cannot be made to open the anonymous door by an outage", async () => {
    // The load is the only thing standing between a database fault and the
    // unauthenticated endpoint, so the property is asserted directly.
    for (const failure of [
      new Error("connection refused"),
      new Error("timeout"),
      Object.assign(new Error("P2021"), { code: "P2021" }),
    ]) {
      mocks.findUnique.mockRejectedValueOnce(failure);
      const settings = await loadMaintenanceReportSettings();
      expect(settings.anonymousReportsEnabled).toBe(false);
    }
  });
});

describe("normalizeMaintenanceReportSettings", () => {
  it("fills every field from the defaults when handed null or undefined", () => {
    expect(normalizeMaintenanceReportSettings(null)).toEqual({
      ...DEFAULT_MAINTENANCE_REPORT_SETTINGS,
    });
    expect(normalizeMaintenanceReportSettings(undefined)).toEqual({
      ...DEFAULT_MAINTENANCE_REPORT_SETTINGS,
    });
  });

  it("keeps an explicit false rather than treating it as absent", () => {
    // `??` and not `||`: `photosEnabled: false` is a club's decision, and a
    // falsy-coalescing bug would silently switch photos back on.
    const normalised = normalizeMaintenanceReportSettings({
      photosEnabled: false,
      anonymousPhotosEnabled: false,
      anonymousContactPrompt: false,
    });

    expect(normalised.photosEnabled).toBe(false);
    expect(normalised.anonymousPhotosEnabled).toBe(false);
    expect(normalised.anonymousContactPrompt).toBe(false);
  });

  it("keeps an explicit true for the anonymous switch", () => {
    expect(
      normalizeMaintenanceReportSettings({ anonymousReportsEnabled: true })
        .anonymousReportsEnabled,
    ).toBe(true);
  });

  it("clamps a stored retention window that is out of bounds", () => {
    // A restored backup or an older release can hold a value the current bounds
    // refuse. A read must still produce a usable window.
    expect(
      normalizeMaintenanceReportSettings({ photoRetentionDays: 100_000 })
        .photoRetentionDays,
    ).toBe(MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX);
    expect(
      normalizeMaintenanceReportSettings({ photoRetentionDays: 0 })
        .photoRetentionDays,
    ).toBe(MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN);
  });

  it("returns only the five policy fields, never the whole row", () => {
    const normalised = normalizeMaintenanceReportSettings(
      storedRow({ updatedByMemberId: "admin-1" }) as never,
    );

    expect(Object.keys(normalised).sort()).toEqual([
      "anonymousContactPrompt",
      "anonymousPhotosEnabled",
      "anonymousReportsEnabled",
      "photoRetentionDays",
      "photosEnabled",
    ]);
  });
});

describe("clampPhotoRetentionDays", () => {
  it.each([
    ["below the minimum", 0, MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN],
    ["negative", -40, MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN],
    ["above the maximum", 4000, MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX],
    ["exactly the minimum", 1, 1],
    ["exactly the maximum", 365, 365],
    ["inside the range", 14, 14],
  ])("clamps a value %s", (_label, input, expected) => {
    expect(clampPhotoRetentionDays(input)).toBe(expected);
  });

  it("truncates a fractional value toward zero", () => {
    expect(clampPhotoRetentionDays(30.9)).toBe(30);
    // Truncation happens inside the clamp, so 0.9 cannot become a zero-day
    // window: it is raised to the minimum.
    expect(clampPhotoRetentionDays(0.9)).toBe(
      MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN,
    );
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("falls back to the default for %s rather than producing an invalid date", (
    _label,
    input,
  ) => {
    expect(clampPhotoRetentionDays(input)).toBe(
      DEFAULT_MAINTENANCE_REPORT_SETTINGS.photoRetentionDays,
    );
  });

  it("never returns a value that would make an expiry in the past", () => {
    for (const input of [-1, 0, Number.NaN, 0.4]) {
      expect(clampPhotoRetentionDays(input)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("getMaintenancePhotoExpiresAt", () => {
  it("stamps the window forward from the capture instant", () => {
    const capturedAt = new Date("2026-07-01T00:00:00.000Z");

    expect(getMaintenancePhotoExpiresAt(30, capturedAt).toISOString()).toBe(
      "2026-07-31T00:00:00.000Z",
    );
    expect(getMaintenancePhotoExpiresAt(1, capturedAt).toISOString()).toBe(
      "2026-07-02T00:00:00.000Z",
    );
  });

  it("defaults the capture instant to now, which the harness freezes", () => {
    expect(getMaintenancePhotoExpiresAt(30).getTime()).toBe(
      FROZEN_NOW.getTime() + 30 * DAY_MS,
    );
  });

  it("clamps the window it is given rather than trusting it", () => {
    const capturedAt = new Date("2026-07-01T00:00:00.000Z");

    expect(getMaintenancePhotoExpiresAt(100_000, capturedAt).getTime()).toBe(
      capturedAt.getTime() + MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX * DAY_MS,
    );
    expect(getMaintenancePhotoExpiresAt(0, capturedAt).getTime()).toBe(
      capturedAt.getTime() + MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN * DAY_MS,
    );
  });

  it("always returns an expiry strictly after the capture instant", () => {
    const capturedAt = new Date("2026-07-01T00:00:00.000Z");

    for (const days of [-5, 0, Number.NaN, 1, 365, 10_000]) {
      expect(
        getMaintenancePhotoExpiresAt(days, capturedAt).getTime(),
      ).toBeGreaterThan(capturedAt.getTime());
    }
  });
});
