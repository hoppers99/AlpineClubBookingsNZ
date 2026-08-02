// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #2548: the Recipients grid lists every admin user, and an alert category that
 * belongs to an area the admin's role cannot edit renders locked rather than
 * pretending a tick would subscribe them.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

import { toast } from "sonner";
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

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

  /**
   * #2548 review finding 2: Save fires one request per changed admin. A single
   * refusal used to reject the whole Promise.all and the catch reverted EVERY
   * card, throwing away unrelated edits. Failures must be isolated to their own
   * card.
   */
  describe("per-card save isolation", () => {
    const fullAdmin = { accessRoles: [{ role: "ADMIN" }], canLogin: true };

    function fullAdminCard(id: string, name: string) {
      return {
        id,
        name,
        email: `${id}@club.test`,
        roleLabels: ["Full Admin"],
        availableKeys: adminNotificationKeysForMember(fullAdmin),
        preferences: resolveEffectiveAdminNotificationPreferences(fullAdmin, null),
      };
    }

    function checkbox(container: HTMLElement, id: string, key: string) {
      const element = container.querySelector(`[id="${id}-${key}"]`);
      if (!element) throw new Error(`No checkbox for ${id}-${key}`);
      return element as HTMLElement;
    }

    it("keeps the saved card and reverts only the refused one", async () => {
      const allOnExceptNewBooking = {
        ...resolveEffectiveAdminNotificationPreferences(fullAdmin, null),
        adminNewBooking: false,
      };
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { memberId: string };
        if (body.memberId === "admin-b") {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: "Stale page: reload and try again." }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            memberId: body.memberId,
            preferences: allOnExceptNewBooking,
          }),
        } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const { container } = render(
        <AdminNotificationSettings
          initialAdmins={[
            fullAdminCard("admin-a", "Ada Admin"),
            fullAdminCard("admin-b", "Bob Admin"),
          ]}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /^Edit$/i }));
      fireEvent.click(checkbox(container, "admin-a", "adminNewBooking"));
      fireEvent.click(checkbox(container, "admin-b", "adminNewBooking"));
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // Ada's edit survived; Bob's was rolled back to the last saved value.
      await waitFor(() =>
        expect(
          checkbox(container, "admin-a", "adminNewBooking"),
        ).not.toBeChecked(),
      );
      expect(checkbox(container, "admin-b", "adminNewBooking")).toBeChecked();

      // Nothing else on either card was disturbed.
      expect(checkbox(container, "admin-a", "adminRefundRequest")).toBeChecked();
      expect(checkbox(container, "admin-b", "adminRefundRequest")).toBeChecked();

      // Still in edit mode, with the failure named so it can be retried.
      expect(
        screen.getByRole("button", { name: /Save Changes/i }),
      ).toBeInTheDocument();
      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain("Bob Admin");
      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain(
        "Saved 1 of 2 admins",
      );
    });

    it("leaves edit mode when every card saves", async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { memberId: string };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            memberId: body.memberId,
            preferences: {
              ...resolveEffectiveAdminNotificationPreferences(fullAdmin, null),
              adminNewBooking: false,
            },
          }),
        } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const { container } = render(
        <AdminNotificationSettings
          initialAdmins={[
            fullAdminCard("admin-a", "Ada Admin"),
            fullAdminCard("admin-b", "Bob Admin"),
          ]}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /^Edit$/i }));
      fireEvent.click(checkbox(container, "admin-a", "adminNewBooking"));
      fireEvent.click(checkbox(container, "admin-b", "adminNewBooking"));
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: /^Edit$/i })).toBeInTheDocument(),
      );
      expect(toast.error).not.toHaveBeenCalled();
      expect(checkbox(container, "admin-a", "adminNewBooking")).not.toBeChecked();
      expect(checkbox(container, "admin-b", "adminNewBooking")).not.toBeChecked();
    });
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
