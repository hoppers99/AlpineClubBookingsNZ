import { describe, expect, it } from "vitest";

import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT,
  adminNotificationKeysForMember,
  canReceiveAdminNotification,
  isAdminNotificationRecipient,
  resolveEffectiveAdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";
import { ADMIN_PERMISSION_AREAS } from "@/lib/admin-permissions";

/**
 * #2548: admin alert audiences are area-aware. These are the pure
 * default-matrix rules — which alert categories each kind of admin holds before
 * anybody edits the Recipients grid. The delivery side (who is actually emailed)
 * is covered in src/lib/email/__tests__/admin-alert-audience.test.ts.
 */

const BOOKING_KEYS = [
  "adminNewBooking",
  "adminPendingDeadline",
  "adminBookingBumped",
  "adminCapacityWarning",
  "adminWaitlistOffer",
  "adminBookingChangeRequest",
  "adminBookingRequest",
  "adminBookingReviewRequired",
] as const;
const FINANCE_KEYS = [
  "adminPaymentFailure",
  "adminXeroSyncError",
  "adminRefundRequest",
] as const;
const MEMBERSHIP_KEYS = [
  "adminFamilyGroupRequest",
  "adminMemberDeleteRequest",
] as const;

function member(role: string) {
  return { accessRoles: [{ role }], canLogin: true };
}

/** A definition-backed CUSTOM role: `role` is null, the matrix is the row. */
function customRole(
  levels: Partial<Record<string, "NONE" | "VIEW" | "EDIT">>,
  options: { canLogin?: boolean } = {},
) {
  return {
    canLogin: options.canLogin ?? true,
    accessRoles: [
      {
        role: null,
        roleDefinitionId: "ardef_custom",
        roleDefinition: {
          id: "ardef_custom",
          overviewLevel: "NONE" as const,
          bookingsLevel: "NONE" as const,
          membershipLevel: "NONE" as const,
          financeLevel: "NONE" as const,
          lodgeLevel: "NONE" as const,
          contentLevel: "NONE" as const,
          supportLevel: "NONE" as const,
          ...levels,
        },
      },
    ],
  };
}

describe("admin notification category → permission area map (#2548)", () => {
  it("maps every preference key to a known admin permission area", () => {
    const areas = ADMIN_PERMISSION_AREAS.map((area) => area.key);
    for (const key of ADMIN_NOTIFICATION_PREFERENCE_KEYS) {
      const requirement = ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT[key];
      expect(requirement, `${key} has no area requirement`).toBeDefined();
      expect(areas).toContain(requirement.area);
      // Alerts are requests to act, so they follow edit access. `view` would
      // post finance and membership alerts to every scoped officer, because
      // the scoped bundles all carry view on the areas they do not own.
      expect(requirement.level).toBe("edit");
    }
  });

  it("has a requirement for exactly the fifteen preference keys", () => {
    expect(Object.keys(ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT).sort()).toEqual(
      [...ADMIN_NOTIFICATION_PREFERENCE_KEYS].sort(),
    );
  });
});

describe("default alert matrix per role (#2548)", () => {
  it("gives a Full Admin every category, exactly as before", () => {
    expect(adminNotificationKeysForMember(member("ADMIN"))).toEqual(
      ADMIN_NOTIFICATION_PREFERENCE_KEYS,
    );
    const defaults = resolveEffectiveAdminNotificationPreferences(
      member("ADMIN"),
      null,
    );
    expect(Object.values(defaults).every(Boolean)).toBe(true);
  });

  it("gives a Booking Officer the booking categories and nothing else", () => {
    const keys = adminNotificationKeysForMember(member("ADMIN_BOOKINGS"));
    expect([...keys].sort()).toEqual([...BOOKING_KEYS].sort());

    const defaults = resolveEffectiveAdminNotificationPreferences(
      member("ADMIN_BOOKINGS"),
      null,
    );
    // The alert the owner expected to already reach them (#2542, #2548).
    expect(defaults.adminBookingChangeRequest).toBe(true);
    // …and the ones that must NOT start reaching them, even though the Booking
    // Officer bundle carries finance/membership/support at `view`.
    expect(defaults.adminPaymentFailure).toBe(false);
    expect(defaults.adminXeroSyncError).toBe(false);
    expect(defaults.adminRefundRequest).toBe(false);
    expect(defaults.adminFamilyGroupRequest).toBe(false);
    expect(defaults.adminIssueReport).toBe(false);
    expect(defaults.adminDailyDigest).toBe(false);
  });

  it("gives a Membership Officer the membership categories only", () => {
    expect([...adminNotificationKeysForMember(member("ADMIN_MEMBERSHIP"))].sort()).toEqual(
      [...MEMBERSHIP_KEYS].sort(),
    );
  });

  it("gives a Treasurer the finance categories only", () => {
    expect([...adminNotificationKeysForMember(member("FINANCE_ADMIN"))].sort()).toEqual(
      [...FINANCE_KEYS].sort(),
    );
  });

  it("gives a Read-only Admin and a Content Manager nothing to receive", () => {
    expect(adminNotificationKeysForMember(member("ADMIN_READONLY"))).toEqual([]);
    expect(adminNotificationKeysForMember(member("ADMIN_CONTENT"))).toEqual([]);
  });

  it("gives a plain member nothing", () => {
    expect(adminNotificationKeysForMember(member("USER"))).toEqual([]);
    expect(adminNotificationKeysForMember({ accessRoles: [], canLogin: true })).toEqual(
      [],
    );
  });

  it("resolves a definition-backed custom role instead of silently dropping it", () => {
    const officer = customRole({ overviewLevel: "VIEW", bookingsLevel: "EDIT" });
    expect([...adminNotificationKeysForMember(officer)].sort()).toEqual(
      [...BOOKING_KEYS].sort(),
    );
    expect(canReceiveAdminNotification(officer, "adminBookingChangeRequest")).toBe(
      true,
    );
    expect(canReceiveAdminNotification(officer, "adminRefundRequest")).toBe(false);
    expect(isAdminNotificationRecipient(officer)).toBe(true);
  });

  it("gives a custom role with overview edit the cross-area daily digest", () => {
    expect(
      canReceiveAdminNotification(
        customRole({ overviewLevel: "EDIT" }),
        "adminDailyDigest",
      ),
    ).toBe(true);
  });

  it("clears every category when login is disabled", () => {
    expect(
      adminNotificationKeysForMember({
        accessRoles: [{ role: "ADMIN" }],
        canLogin: false,
      }),
    ).toEqual([]);
    expect(
      adminNotificationKeysForMember(
        customRole({ bookingsLevel: "EDIT" }, { canLogin: false }),
      ),
    ).toEqual([]);
    expect(
      isAdminNotificationRecipient({
        accessRoles: [{ role: "ADMIN" }],
        canLogin: false,
      }),
    ).toBe(false);
  });
});

describe("stored preferences vs area mask (#2548)", () => {
  it("never turns a stored true into delivery outside the member's areas", () => {
    // The `admin*` columns are non-null and default to TRUE in the database, so
    // any officer who ever saved a personal email preference carries fifteen
    // `true`s they never chose. The mask is what stops those reaching them.
    const allStoredOn = Object.fromEntries(
      ADMIN_NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, true]),
    );
    const effective = resolveEffectiveAdminNotificationPreferences(
      member("ADMIN_BOOKINGS"),
      allStoredOn,
    );
    expect(effective.adminPaymentFailure).toBe(false);
    expect(effective.adminNewBooking).toBe(true);
  });

  it("still honours an explicit opt-out inside the member's own area", () => {
    const effective = resolveEffectiveAdminNotificationPreferences(
      member("ADMIN_BOOKINGS"),
      { adminBookingChangeRequest: false },
    );
    expect(effective.adminBookingChangeRequest).toBe(false);
    expect(effective.adminNewBooking).toBe(true);
  });

  it("leaves the Full Admin resolution unchanged by the mask", () => {
    const effective = resolveEffectiveAdminNotificationPreferences(member("ADMIN"), {
      adminNewBooking: false,
    });
    expect(effective.adminNewBooking).toBe(false);
    expect(effective.adminPaymentFailure).toBe(true);
    expect(effective.adminDailyDigest).toBe(true);
  });
});

describe("Recipients grid eligibility (#2548)", () => {
  it("includes scoped officers and read-only admins, not plain members", () => {
    expect(isAdminNotificationRecipient(member("ADMIN"))).toBe(true);
    expect(isAdminNotificationRecipient(member("ADMIN_BOOKINGS"))).toBe(true);
    expect(isAdminNotificationRecipient(member("ADMIN_MEMBERSHIP"))).toBe(true);
    expect(isAdminNotificationRecipient(member("FINANCE_ADMIN"))).toBe(true);
    // Portal access but no editable alert area: listed so an operator can see
    // why they receive nothing.
    expect(isAdminNotificationRecipient(member("ADMIN_READONLY"))).toBe(true);
    expect(isAdminNotificationRecipient(member("USER"))).toBe(false);
    expect(isAdminNotificationRecipient(member("LODGE"))).toBe(false);
  });

  it("includes a finance-only custom role that owns finance alerts", () => {
    // No admin-portal access (finance is excluded from the portal check), but
    // it can be sent finance alerts, so it must be configurable.
    const financeOnly = customRole({ financeLevel: "EDIT" });
    expect(isAdminNotificationRecipient(financeOnly)).toBe(true);
    expect([...adminNotificationKeysForMember(financeOnly)].sort()).toEqual(
      [...FINANCE_KEYS].sort(),
    );
  });
});
