// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #2548: the Recipients grid lists every admin user, and an alert category that
 * belongs to an area the admin's role cannot edit renders locked rather than
 * pretending a tick would subscribe them.
 */

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "u1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
    status: "authenticated",
  }),
}));

import { AdminNotificationSettings } from "@/app/(admin)/admin/notifications/notifications-settings";
import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  adminNotificationKeysForMember,
  resolveEffectiveAdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";

const bookingOfficer = { accessRoles: [{ role: "ADMIN_BOOKINGS" }], canLogin: true };

function officerCard() {
  return {
    id: "officer-1",
    name: "Bea Officer",
    email: "officer@club.test",
    roleLabels: ["Booking Officer"],
    availableKeys: adminNotificationKeysForMember(bookingOfficer),
    preferences: resolveEffectiveAdminNotificationPreferences(bookingOfficer, null),
  };
}

afterEach(cleanup);

describe("Recipients grid availability (#2548)", () => {
  it("shows a scoped officer with their own area ticked and other areas locked", () => {
    render(<AdminNotificationSettings initialAdmins={[officerCard()]} />);

    expect(screen.getByText("Booking Officer")).toBeInTheDocument();

    const bookingChange = screen.getByLabelText("Booking change requests");
    expect(bookingChange).toBeChecked();

    const refunds = screen.getByLabelText("Refund requests");
    expect(refunds).not.toBeChecked();
    expect(refunds).toBeDisabled();
  });

  it("keeps a locked category locked and unticked while editing", () => {
    render(<AdminNotificationSettings initialAdmins={[officerCard()]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Edit$/i }));

    expect(screen.getByLabelText("Booking change requests")).toBeEnabled();

    const refunds = screen.getByLabelText("Refund requests");
    expect(refunds).toBeDisabled();
    fireEvent.click(refunds);
    expect(refunds).not.toBeChecked();
  });

  it("explains an admin whose role owns no alert categories", () => {
    const readOnly = { accessRoles: [{ role: "ADMIN_READONLY" }], canLogin: true };
    render(
      <AdminNotificationSettings
        initialAdmins={[
          {
            id: "ro-1",
            name: "Reed Only",
            email: "readonly@club.test",
            roleLabels: ["Read-only Admin"],
            availableKeys: adminNotificationKeysForMember(readOnly),
            preferences: resolveEffectiveAdminNotificationPreferences(readOnly, null),
          },
        ]}
      />,
    );

    expect(
      screen.getByText(/cannot edit any area that owns an alert/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("New bookings")).toBeDisabled();
    expect(screen.getByLabelText("Payment failures")).toBeDisabled();
  });

  it("leaves a Full Admin card fully editable", () => {
    const fullAdmin = { accessRoles: [{ role: "ADMIN" }], canLogin: true };
    const { container } = render(
      <AdminNotificationSettings
        initialAdmins={[
          {
            id: "admin-1",
            name: "Ada Admin",
            email: "ada@club.test",
            roleLabels: ["Full Admin"],
            availableKeys: adminNotificationKeysForMember(fullAdmin),
            preferences: resolveEffectiveAdminNotificationPreferences(fullAdmin, null),
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Edit$/i }));

    const boxes = within(container).getAllByRole("checkbox");
    expect(boxes).toHaveLength(ADMIN_NOTIFICATION_PREFERENCE_KEYS.length);
    for (const box of boxes) {
      expect(box).toBeEnabled();
      expect(box).toBeChecked();
    }
  });
});
