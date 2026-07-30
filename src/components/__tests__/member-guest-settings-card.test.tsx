// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2307 — the Member guests settings card on Admin › Bookings setup (owner
// decisions MG2-M-1 and MG2-M-4 as ticked). Three honest states: normal
// editable; module-off editable with the not-in-use banner; and view-only as a
// REAL third state — the banner explains, and no Save that would 403 is ever
// live. The name-search warning copy is the owner-accepted wording verbatim.

const h = vi.hoisted(() => ({
  canEdit: true as boolean | undefined,
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  ADMIN_VIEW_ONLY_ACTION_REASON:
    "Your admin role can view this area but cannot make changes.",
  useAdminAreaEditAccess: () => h.canEdit,
}));

import { MemberGuestSettingsCard } from "@/components/admin/member-guest-settings-card";

const PAYLOAD = {
  settings: {
    approvalRequired: true,
    pendingHoldExpiryDays: 7,
    openMemberSearchEnabled: false,
    openMemberSearchIncludesMinors: false,
  },
  updatedAt: "2026-07-30T00:00:00.000Z",
  updatedByMemberId: "m-admin",
  access: "manage",
  bounds: { pendingHoldExpiryDaysMin: 1, pendingHoldExpiryDaysMax: 60 },
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.canEdit = true;
  fetchMock = vi.fn(async () => jsonResponse(PAYLOAD));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderCard(moduleEnabled = true) {
  render(<MemberGuestSettingsCard moduleEnabled={moduleEnabled} />);
  await waitFor(() =>
    expect(screen.getByText("Member guests")).toBeInTheDocument(),
  );
}

describe("MemberGuestSettingsCard", () => {
  it("renders the policy controls with the signed-off copy", async () => {
    await renderCard();

    expect(
      screen.getByText(/Lets a member add another club member/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Does the other member have to agree first?"),
    ).toBeInTheDocument();
    expect(screen.getByText("Ask them first")).toBeInTheDocument();
    expect(
      screen.getByText(/Recommended, and the default\./),
    ).toBeInTheDocument();
    expect(screen.getByText("Just tell them")).toBeInTheDocument();
    expect(
      screen.getByLabelText("How long to wait for an answer"),
    ).toHaveValue(7);
    expect(
      screen.getByText(/A request never outlives the stay/),
    ).toBeInTheDocument();
    // The two privacy warnings, word for word as accepted on the mockup pack.
    expect(
      screen.getByText(
        "Turning this on makes your membership list browsable. Any member can type a few letters and see the names of other members who match. Leave it off unless your club has agreed to that.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Turning this on makes children's names browsable to any member. A child can still be added by their household email address either way.",
      ),
    ).toBeInTheDocument();
    // D-18: the config-transfer exclusion, stated on the card.
    expect(
      screen.getByText(/These two search settings never travel in club config transfer/),
    ).toBeInTheDocument();
    // No not-in-use banner while the module is on.
    expect(screen.queryByText(/switched off, so none of this is in use/)).toBeNull();
  });

  it("keeps the card editable while the module is off, with the not-in-use banner (MG2-M-4)", async () => {
    await renderCard(false);

    expect(
      screen.getByText(/Member guests is switched off, so none of this is in use/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/turn the module on under/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Admin › Modules" })).toHaveAttribute(
      "href",
      "/admin/modules",
    );
    // Still fully configurable: Edit is a live control.
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
  });

  it("saves the whole form once Edit is opened, and re-seeds from the response", async () => {
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("How long to wait for an answer"), {
      target: { value: "14" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Just tell them/ }));

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...PAYLOAD,
        settings: { ...PAYLOAD.settings, approvalRequired: false, pendingHoldExpiryDays: 14 },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("Member guest settings saved")).toBeInTheDocument(),
    );
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      approvalRequired: false,
      pendingHoldExpiryDays: 14,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
    });
  });

  it("renders view-only as a real third state: banner in the reading order, no live Save", async () => {
    h.canEdit = false;
    await renderCard();

    expect(
      screen.getByText(
        /You can see these settings but not change them\. Ask an administrator with booking-settings access if something here needs changing\./,
      ),
    ).toBeInTheDocument();
    // The Edit affordance is present but disabled by the shared view-only
    // control — it can never fire a PUT that 403s.
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).toBeDisabled();
    expect(fetchMock.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method || (init as RequestInit).method === "GET")).toBe(true);
  });
});
