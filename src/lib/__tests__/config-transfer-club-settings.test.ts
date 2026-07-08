import { describe, expect, it, vi } from "vitest";
import { strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { readBundle } from "@/lib/config-transfer/bundle";
import type { ReadDb } from "@/lib/config-transfer/import-types";

// Delegate names touched by the club-settings category.
const SINGLETON_DELEGATES = [
  "clubModuleSettings",
  "bookingDefaults",
  "memberFieldsSettings",
  "bedAllocationSettings",
  "bookingRequestSettings",
  "internetBankingPaymentSettings",
  "emailMessageSetting",
  "groupDiscountSetting",
  "membershipNominationSettings",
  "membershipLockoutSettings",
  "membershipCancellationSetting",
];

/** Build a stub DB whose singleton delegates return the given rows (else null). */
function stubDb(rows: Record<string, Record<string, unknown> | null>): ReadDb {
  const db: Record<string, unknown> = {
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  for (const name of SINGLETON_DELEGATES) {
    db[name] = {
      findUnique: vi.fn().mockResolvedValue(rows[name] ?? null),
    };
  }
  return db as unknown as ReadDb;
}

const MODULES = {
  kiosk: false, chores: false, financeDashboard: false, waitlist: false,
  xeroIntegration: false, bedAllocation: true, internetBankingPayments: false,
  addressAutocomplete: false, groupBookings: true, lockers: true,
  induction: true, workParties: true, promoCodes: true, hutLeaders: true,
  communications: true, skifieldConditions: true, multiLodge: true,
  twoFactor: false, analytics: false,
};
const EMAIL = {
  clubName: "Grads", bookingsName: "Bookings", lodgeName: "Lodge",
  emailFromName: "Grads", supportEmail: "s@x.nz", contactEmail: "c@x.nz",
  publicUrl: "https://x.nz", lodgeTravelNote: "Turn left", doorCode: "1234",
};

async function exportBundle(includeDoorCodes: boolean) {
  return buildConfigExport({
    db: stubDb({ clubModuleSettings: MODULES, emailMessageSetting: EMAIL }),
    categories: ["club-settings"],
    includeDoorCodes,
    appVersion: "0.10.1",
    prismaMigration: null,
    sourceXeroTenantId: null,
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

describe("config-transfer club-settings", () => {
  it("exports present singletons as JSON and omits door codes by default", async () => {
    const { zip } = await exportBundle(false);
    const { manifest, files } = readBundle(zip);
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain("club-settings/club-module-settings.json");
    expect(paths).toContain("club-settings/email-message-setting.json");
    // Absent singletons are not emitted.
    expect(paths).not.toContain("club-settings/booking-defaults.json");

    const email = JSON.parse(
      strFromU8(files.get("club-settings/email-message-setting.json")!),
    );
    expect(email.clubName).toBe("Grads");
    expect("doorCode" in email).toBe(false);
  });

  it("includes door codes only when opted in", async () => {
    const { zip } = await exportBundle(true);
    const { files } = readBundle(zip);
    const email = JSON.parse(
      strFromU8(files.get("club-settings/email-message-setting.json")!),
    );
    expect(email.doorCode).toBe("1234");
  });

  it("plans singleton create vs update against the target DB", async () => {
    const { zip } = await exportBundle(false);
    // Target: module settings differ (update); email settings absent (create).
    const target = stubDb({
      clubModuleSettings: { ...MODULES, multiLodge: false },
    });
    const plan = await buildImportPlan(target, zip);
    const items = plan.categories[0].items;
    const modules = items.find((i) => i.entity === "club-module-settings");
    const email = items.find((i) => i.entity === "email-message-setting");
    expect(modules?.action).toBe("update");
    expect(modules?.changedFields).toContain("multiLodge");
    expect(email?.action).toBe("create");
  });
});
