// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "u1", adminPermissionMatrix: { support: "edit" } } },
    status: "authenticated",
  }),
}));

vi.mock("@/components/admin/lodge-capacity-card", () => ({
  LodgeCapacityCard: () => <div data-testid="lodge-card" />,
}));

import { SetupPageClient } from "@/app/(admin)/admin/setup/setup-page-client";

/**
 * THE PROGRESS TILE ON `/admin/setup` (#237 fix round).
 *
 * The tile used to derive its own percentage from
 * `status === "complete" || progress === "completed"` — the union D14 split
 * apart — so a freshly seeded install read 56% here and 0% one click away in the
 * wizard, which is the contradiction `docs/guides/setup.md` promises cannot
 * happen. It now renders `wizardPercentComplete` off the payload, which the
 * route takes from `buildSetupWizardTraversal`.
 *
 * The fixture below is built so the two answers CANNOT coincide: three of four
 * checks pass on their own and none is confirmed, so the old union renders 75%
 * and the honest number is 0. A restored union therefore fails this file rather
 * than passing it in a different shade.
 *
 * The two routes' halves of the same guarantee are pinned in
 * `src/app/api/admin/setup/__tests__/route-progress-parity.test.ts`.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Four foundation checks, three of them passing with nobody having said so. */
const defaultedCategory = {
  id: "foundation",
  title: "Foundation",
  description: "Club identity and first-install readiness.",
  status: "warning",
  checks: [
    {
      id: "club-time-zone",
      title: "Club Time Zone",
      description: "The club's civil time.",
      status: "complete",
      required: true,
      message: "Pacific/Auckland is set.",
      details: [],
      href: "/admin/club-time",
      progress: "open",
    },
    {
      id: "age-tiers",
      title: "Age Tiers",
      description: "Adult, youth and child bands.",
      status: "complete",
      required: true,
      message: "Four age tiers are configured.",
      details: [],
      href: "/admin/fees",
      progress: "open",
    },
    {
      id: "booking-policies",
      title: "Booking Policy",
      description: "Holds, lead times and cut-offs.",
      status: "complete",
      required: true,
      message: "Booking defaults are configured.",
      details: [],
      href: "/admin/booking-policies",
      progress: "open",
    },
    {
      id: "seed-admin",
      title: "First Admin",
      description: "Seeded administrator account.",
      status: "blocked",
      required: true,
      message: "No administrator account was found.",
      details: [],
      href: "/admin/members",
      progress: "open",
    },
  ],
};

function payload(wizardPercentComplete: number | undefined) {
  return {
    readiness: {
      status: "warning",
      summary: { total: 4, complete: 3, warning: 0, blocked: 1, skipped: 0 },
      categories: [defaultedCategory],
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
    progress: {
      completedStepIds: [],
      skippedStepIds: [],
      completedAt: null,
      completedByMemberId: null,
    },
    ...(wizardPercentComplete === undefined ? {} : { wizardPercentComplete }),
  };
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/api/admin/setup/surfaces")
          ? { settings: { legacySurfacesHidden: false } }
          : body,
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function renderSetup(overrides: Partial<AdminPermissionMatrix> = {}) {
  return render(
    <SetupPageClient
      permissionMatrix={{ ...emptyAdminPermissionMatrix(), ...overrides }}
      features={allOn}
      legacySurfacesHidden={false}
    />,
  );
}

describe("the Progress tile on /admin/setup", () => {
  it("shows the wizard's confirmed-only number, not the readiness union", async () => {
    stubFetch(payload(0));
    renderSetup({ support: "view" });

    await waitFor(() => {
      expect(screen.getByTestId("setup-progress-percent").textContent).toBe(
        "0%",
      );
    });
    // The union this fixture would produce, named so a regression is legible in
    // the failure rather than only in the diff.
    expect(screen.queryByText("75%")).toBeNull();
  });

  it("renders the number the payload carries rather than one of its own", async () => {
    stubFetch(payload(40));
    renderSetup({ support: "view" });

    await waitFor(() => {
      expect(screen.getByTestId("setup-progress-percent").textContent).toBe(
        "40%",
      );
    });
  });

  /*
    A payload with no percentage at all — an older server, or a stub written
    before this key existed. "0%" would be a claim this page cannot make and
    "undefined%" is a bug on screen, so it says neither.
  */
  it("says nothing rather than 0% when the payload carries no percentage", async () => {
    stubFetch(payload(undefined));
    renderSetup({ support: "view" });

    await waitFor(() => {
      expect(screen.getByTestId("setup-progress-percent").textContent).toBe("—");
    });
  });

  it("names which question the number answers, beside the cards' own", async () => {
    stubFetch(payload(0));
    renderSetup({ support: "view" });

    await waitFor(() => {
      expect(
        screen.getByText(/the same number the setup wizard shows/i),
      ).toBeTruthy();
    });
  });
});
