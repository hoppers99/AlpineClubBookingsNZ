import { describe, expect, it, vi } from "vitest";
import type { AgeTier } from "@prisma/client";
import {
  applyWizardConfigToDatabase,
  readWizardConfigState,
  type WizardConfigValues,
  type WizardDbClient,
} from "@/lib/setup-wizard-db";

function makeDelegate(findUniqueResult: Record<string, unknown> | null = null, countResult = 0) {
  return {
    upsert: vi.fn().mockResolvedValue({}),
    findUnique: vi.fn().mockResolvedValue(findUniqueResult),
    count: vi.fn().mockResolvedValue(countResult),
  };
}

function makeDb(overrides?: {
  identity?: Record<string, unknown> | null;
  email?: Record<string, unknown> | null;
  lodge?: Record<string, unknown> | null;
  ageTierCount?: number;
}): WizardDbClient {
  return {
    clubIdentitySettings: makeDelegate(overrides?.identity ?? null),
    emailMessageSetting: makeDelegate(overrides?.email ?? null),
    lodgeSettings: makeDelegate(overrides?.lodge ?? null),
    ageTierSetting: makeDelegate(null, overrides?.ageTierCount ?? 0),
  } as unknown as WizardDbClient;
}

const values: WizardConfigValues = {
  name: "Rimutaka Alpine Club",
  shortName: "RAC",
  supportEmail: "support@rac.example",
  contactEmail: "bookings@rac.example",
  publicUrl: "https://rac.example",
  emailFromName: "Rimutaka Alpine Club - Online Booking System",
  capacity: 24,
  ageTiers: [
    {
      tier: "INFANT" as AgeTier,
      minAge: 0,
      maxAge: 4,
      label: "Infant",
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: 0,
    },
    {
      tier: "ADULT" as AgeTier,
      minAge: 18,
      maxAge: null,
      label: "Adult",
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      sortOrder: 1,
    },
  ],
};

describe("setup-wizard-db", () => {
  it("writes identity, email, capacity, and age tiers to the DB (no file involved)", async () => {
    const db = makeDb();
    await applyWizardConfigToDatabase(values, db);

    const identity = db.clubIdentitySettings.upsert as ReturnType<typeof vi.fn>;
    expect(identity).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: expect.objectContaining({ name: "Rimutaka Alpine Club", shortName: "RAC", updatedByMemberId: null }),
        create: expect.objectContaining({ id: "default", name: "Rimutaka Alpine Club" }),
      }),
    );

    const email = db.emailMessageSetting.upsert as ReturnType<typeof vi.fn>;
    expect(email).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clubName: "Rimutaka Alpine Club",
          bookingsName: "Rimutaka Alpine Club - Bookings",
          emailFromName: values.emailFromName,
          supportEmail: "support@rac.example",
          contactEmail: "bookings@rac.example",
          publicUrl: "https://rac.example",
          updatedByMemberId: null,
        }),
      }),
    );

    const lodge = db.lodgeSettings.upsert as ReturnType<typeof vi.fn>;
    expect(lodge).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: expect.objectContaining({ capacity: 24, updatedByMemberId: null }),
      }),
    );

    const ageTier = db.ageTierSetting.upsert as ReturnType<typeof vi.fn>;
    expect(ageTier).toHaveBeenCalledTimes(2);
    expect(ageTier).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tier: "INFANT" },
        create: expect.objectContaining({ tier: "INFANT", minAge: 0, maxAge: 4, sortOrder: 0 }),
      }),
    );
    expect(ageTier).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tier: "ADULT" },
        update: expect.objectContaining({ maxAge: null, subscriptionRequiredForBooking: true }),
      }),
    );
  });

  it("reports an unconfigured DB as empty state", async () => {
    const state = await readWizardConfigState(makeDb());
    expect(state).toEqual({
      hasClubIdentity: false,
      hasEmailSettings: false,
      hasLodgeCapacity: false,
      ageTierCount: 0,
      existingClubName: null,
    });
  });

  it("detects an already-configured DB for the overwrite gate", async () => {
    const state = await readWizardConfigState(
      makeDb({
        identity: { name: "Existing Club" },
        email: { clubName: "Existing Club", supportEmail: "s@x.example" },
        lodge: { capacity: 30 },
        ageTierCount: 4,
      }),
    );
    expect(state.hasClubIdentity).toBe(true);
    expect(state.hasEmailSettings).toBe(true);
    expect(state.hasLodgeCapacity).toBe(true);
    expect(state.ageTierCount).toBe(4);
    expect(state.existingClubName).toBe("Existing Club");
  });

  it("propagates a DB error so the CLI can treat it as unreachable", async () => {
    const db = makeDb();
    (db.ageTierSetting.count as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );
    await expect(readWizardConfigState(db)).rejects.toThrow("ECONNREFUSED");
  });
});
