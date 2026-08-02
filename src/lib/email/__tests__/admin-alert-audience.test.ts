import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2548: who actually receives an admin alert. Before this change the resolver
 * queried the legacy scalar `Member.role === "ADMIN"`, so Booking Officers,
 * Membership Officers, Treasurers and every definition-backed CUSTOM role
 * silently received nothing at all. The audience now comes from the access-role
 * permission matrix, area by area.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  sendEmail: vi.fn(),
  shouldSendAdminSystemEmail: vi.fn(),
  recordEscalation: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/notification-delivery-policies", () => ({
  shouldSendAdminSystemEmail: mocks.shouldSendAdminSystemEmail,
}));
vi.mock("@/lib/email-admin-alert-escalation", () => ({
  recordAdminAlertDeliveryEscalation: mocks.recordEscalation,
}));
vi.mock("@/lib/email/core", () => ({ sendEmail: mocks.sendEmail }));

import {
  getAdminEmails,
  sendToAdmins,
} from "@/lib/email/admin-alerts-shared";
import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  type AdminNotificationPreferenceKey,
} from "@/lib/admin-notification-preferences";
import { ADMIN_CAPABLE_MEMBER_WHERE } from "@/lib/access-role-definitions";

type Candidate = {
  email: string;
  canLogin?: boolean;
  accessRoles: Array<Record<string, unknown>>;
  notificationPreference?: Record<string, boolean> | null;
};

function enumRole(email: string, role: string, extra: Partial<Candidate> = {}) {
  return {
    email,
    canLogin: true,
    accessRoles: [{ role, roleDefinitionId: null, roleDefinition: null }],
    notificationPreference: null,
    ...extra,
  } satisfies Candidate;
}

/** A club-defined role: no enum value at all, only a definition row. */
function definitionRole(
  email: string,
  levels: Partial<Record<string, "NONE" | "VIEW" | "EDIT">>,
  extra: Partial<Candidate> = {},
) {
  return {
    email,
    canLogin: true,
    accessRoles: [
      {
        role: null,
        roleDefinitionId: "ardef_custom",
        roleDefinition: {
          id: "ardef_custom",
          overviewLevel: "NONE",
          bookingsLevel: "NONE",
          membershipLevel: "NONE",
          financeLevel: "NONE",
          lodgeLevel: "NONE",
          contentLevel: "NONE",
          supportLevel: "NONE",
          ...levels,
        },
      },
    ],
    notificationPreference: null,
    ...extra,
  } satisfies Candidate;
}

async function recipientsFor(
  preferenceKey: AdminNotificationPreferenceKey,
  candidates: Candidate[],
) {
  mocks.findMany.mockResolvedValue(candidates);
  mocks.sendEmail.mockClear();
  await sendToAdmins({
    subject: "Alert",
    html: "<p>alert</p>",
    templateName: `template-${preferenceKey}`,
    preferenceKey,
  });
  return mocks.sendEmail.mock.calls.map((call) => call[0].to as string).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shouldSendAdminSystemEmail.mockResolvedValue({ send: true, mode: "on" });
  mocks.sendEmail.mockResolvedValue({ status: "sent" });
});

describe("admin alert audience is area-aware (#2548)", () => {
  const team: Candidate[] = [
    enumRole("full.admin@club.test", "ADMIN"),
    enumRole("booking.officer@club.test", "ADMIN_BOOKINGS"),
    enumRole("membership.officer@club.test", "ADMIN_MEMBERSHIP"),
    enumRole("treasurer@club.test", "FINANCE_ADMIN"),
    enumRole("readonly@club.test", "ADMIN_READONLY"),
    enumRole("content@club.test", "ADMIN_CONTENT"),
  ];

  it("sends booking-change requests to Full Admins and Booking Officers", async () => {
    expect(await recipientsFor("adminBookingChangeRequest", team)).toEqual([
      "booking.officer@club.test",
      "full.admin@club.test",
    ]);
  });

  it("keeps finance alerts to Full Admins and the Treasurer", async () => {
    expect(await recipientsFor("adminPaymentFailure", team)).toEqual([
      "full.admin@club.test",
      "treasurer@club.test",
    ]);
    expect(await recipientsFor("adminXeroSyncError", team)).toEqual([
      "full.admin@club.test",
      "treasurer@club.test",
    ]);
    expect(await recipientsFor("adminRefundRequest", team)).toEqual([
      "full.admin@club.test",
      "treasurer@club.test",
    ]);
  });

  it("keeps membership alerts to Full Admins and the Membership Officer", async () => {
    expect(await recipientsFor("adminFamilyGroupRequest", team)).toEqual([
      "full.admin@club.test",
      "membership.officer@club.test",
    ]);
    expect(await recipientsFor("adminMemberDeleteRequest", team)).toEqual([
      "full.admin@club.test",
      "membership.officer@club.test",
    ]);
  });

  it("keeps the cross-area digest and support alerts to Full Admins", async () => {
    expect(await recipientsFor("adminDailyDigest", team)).toEqual([
      "full.admin@club.test",
    ]);
    expect(await recipientsFor("adminIssueReport", team)).toEqual([
      "full.admin@club.test",
    ]);
  });

  it("still sends the Full Admin every one of the fifteen categories", async () => {
    for (const key of ADMIN_NOTIFICATION_PREFERENCE_KEYS) {
      expect(
        await recipientsFor(key, [enumRole("full.admin@club.test", "ADMIN")]),
        `Full Admin missed ${key}`,
      ).toEqual(["full.admin@club.test"]);
    }
  });

  it("reaches a definition-backed custom role, which used to get nothing", async () => {
    const custom = definitionRole("custom.officer@club.test", {
      overviewLevel: "VIEW",
      bookingsLevel: "EDIT",
    });
    expect(await recipientsFor("adminBookingChangeRequest", [custom])).toEqual([
      "custom.officer@club.test",
    ]);
    expect(await recipientsFor("adminPaymentFailure", [custom])).toEqual([]);
  });

  it("never mails a login-disabled or role-less account", async () => {
    const candidates: Candidate[] = [
      enumRole("no.login@club.test", "ADMIN", { canLogin: false }),
      enumRole("plain.member@club.test", "USER"),
      definitionRole(
        "ex.officer@club.test",
        { bookingsLevel: "EDIT" },
        { canLogin: false },
      ),
    ];
    expect(await recipientsFor("adminBookingChangeRequest", candidates)).toEqual([]);
    expect(await recipientsFor("adminNewBooking", candidates)).toEqual([]);
  });

  it("queries only active, login-capable holders of a privileged access role", async () => {
    await recipientsFor("adminNewBooking", []);
    // Every ordinary member carries a USER assignment row, so the candidate
    // filter must exclude them or an alert would load the whole club.
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: ADMIN_CAPABLE_MEMBER_WHERE }),
    );
    expect(ADMIN_CAPABLE_MEMBER_WHERE.accessRoles.some.OR[0]).toEqual({
      role: { notIn: ["USER", "ORG"] },
    });
    // The joined role definition must be selected, or custom roles resolve to
    // nothing and drop out of every audience again.
    const select = mocks.findMany.mock.calls[0]?.[0].select;
    expect(select.accessRoles.select.roleDefinition).toBeTruthy();
  });
});

describe("stored preferences still gate delivery (#2548)", () => {
  it("honours an opt-out inside the officer's own area", async () => {
    const officer = enumRole("booking.officer@club.test", "ADMIN_BOOKINGS", {
      notificationPreference: { adminBookingChangeRequest: false },
    });
    expect(await recipientsFor("adminBookingChangeRequest", [officer])).toEqual([]);
    expect(await recipientsFor("adminNewBooking", [officer])).toEqual([
      "booking.officer@club.test",
    ]);
  });

  it("ignores an out-of-area stored true rather than widening the audience", async () => {
    // Non-null database columns default to true, so an officer who ever saved a
    // personal email preference already stores `true` for all fifteen.
    const officer = enumRole("booking.officer@club.test", "ADMIN_BOOKINGS", {
      notificationPreference: Object.fromEntries(
        ADMIN_NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, true]),
      ),
    });
    expect(await recipientsFor("adminRefundRequest", [officer])).toEqual([]);
    expect(await recipientsFor("adminXeroSyncError", [officer])).toEqual([]);
  });

  it("respects an upstream delivery policy that mutes the template club-wide", async () => {
    mocks.shouldSendAdminSystemEmail.mockResolvedValue({
      send: false,
      mode: "off",
      reason: "muted",
    });
    mocks.findMany.mockResolvedValue([enumRole("full.admin@club.test", "ADMIN")]);
    await sendToAdmins({
      subject: "Alert",
      html: "<p>alert</p>",
      templateName: "admin-booking-change-request",
      preferenceKey: "adminBookingChangeRequest",
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe("getAdminEmails system-failure audience (#2548)", () => {
  it("resolves Support & System editors, which always includes Full Admins", async () => {
    mocks.findMany.mockResolvedValue([
      enumRole("full.admin@club.test", "ADMIN"),
      enumRole("booking.officer@club.test", "ADMIN_BOOKINGS"),
      enumRole("treasurer@club.test", "FINANCE_ADMIN"),
      definitionRole("deputy@club.test", { supportLevel: "EDIT" }),
    ]);
    expect(await getAdminEmails()).toEqual([
      "full.admin@club.test",
      "deputy@club.test",
    ]);
  });
});
