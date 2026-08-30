// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
 * "Mark Setup Complete" AND THE SERVER'S ANSWER TO IT (epic #213, C16/#247).
 *
 * This button was the whole of the finish gate until #247: a `disabled` prop
 * that a `curl`, a stale tab or a double-submit went straight past. The server
 * now refuses the transition itself, which only helps an operator if its reason
 * reaches the screen — so what is pinned here is the CLIENT half of #247's
 * acceptance criterion, that the message the route wrote is the message the page
 * shows.
 *
 * The fixture deliberately makes the button ENABLED — every check passing, no
 * required blocker — because the interesting case is the one the client thinks
 * is fine and the server does not. That is exactly the disagreement the old
 * client-side gate could not represent: the page's own idea of "outstanding" is
 * a required check being `blocked`, while the server's is the traversal's
 * blocking set, and the two are different questions.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Everything passing, so nothing on the client's side disables the button. */
const readyCategory = {
  id: "foundation",
  title: "Foundation",
  description: "Club identity and first-install readiness.",
  status: "complete",
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
      progress: "completed",
    },
  ],
};

const setupPayload = {
  readiness: {
    status: "complete",
    summary: { total: 1, complete: 1, warning: 0, blocked: 0, skipped: 0 },
    categories: [readyCategory],
    generatedAt: "2026-01-01T00:00:00.000Z",
  },
  progress: {
    completedStepIds: ["club-time-zone"],
    skippedStepIds: [],
    completedAt: null,
    completedByMemberId: null,
  },
  wizardPercentComplete: 100,
};

const REFUSAL =
  'Setup cannot be marked complete while these steps are outstanding: ' +
  '"club-config", "lodges". Finish or skip each one, then try again. ' +
  "Nothing was changed.";

function stubFetch(progressResponse: { status: number; body: unknown }) {
  const patched = vi.fn();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/admin/setup/progress")) {
      patched({ method: init?.method, body: init?.body });
      return {
        ok: progressResponse.status < 400,
        status: progressResponse.status,
        json: async () => progressResponse.body,
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/api/admin/setup/surfaces")
          ? { settings: { legacySurfacesHidden: false } }
          : setupPayload,
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return { patched };
}

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function renderSetup(overrides: Partial<AdminPermissionMatrix> = {}) {
  return render(
    <SetupPageClient
      permissionMatrix={{ ...emptyAdminPermissionMatrix(), support: "edit", ...overrides }}
      features={allOn}
      legacySurfacesHidden={false}
    />,
  );
}

async function finishButton() {
  return await screen.findByRole("button", { name: /Mark Setup Complete/i });
}

describe("Mark Setup Complete, refused by the server (#247)", () => {
  it("puts the server's reason on screen, naming the steps that block it", async () => {
    stubFetch({ status: 409, body: { error: REFUSAL } });
    renderSetup();

    fireEvent.click(await finishButton());

    // The named ids are the operator's whole route out of the refusal. A generic
    // "Failed to finish setup" — which is what the client falls back to when it
    // discards `body.error` — leaves them with a sixteen-step checklist and no
    // idea which two rows to open.
    expect(await screen.findByText(/club-config/)).toBeTruthy();
    expect(screen.getByText(/lodges/)).toBeTruthy();
    expect(screen.queryByText(/^Failed to finish setup$/)).toBeNull();
  });

  it("does not claim setup is complete after a refusal", async () => {
    stubFetch({ status: 409, body: { error: REFUSAL } });
    renderSetup();

    fireEvent.click(await finishButton());
    await screen.findByText(/club-config/);

    // `setupCompleted` is read from the payload's `completedAt`, which the
    // refusal left null — so the success banner must not appear and the button
    // must still offer the action.
    expect(screen.queryByText("Setup has been marked complete.")).toBeNull();
    expect(await finishButton()).toBeTruthy();
  });

  it("re-enables the button, because nothing was written and a retry is the point", async () => {
    stubFetch({ status: 409, body: { error: REFUSAL } });
    renderSetup();

    fireEvent.click(await finishButton());
    await screen.findByText(/club-config/);

    await waitFor(async () => {
      expect((await finishButton()).hasAttribute("disabled")).toBe(false);
    });
  });

  it("sends the finish action and nothing else", async () => {
    const { patched } = stubFetch({ status: 409, body: { error: REFUSAL } });
    renderSetup();

    fireEvent.click(await finishButton());

    await waitFor(() => expect(patched).toHaveBeenCalledTimes(1));
    expect(patched.mock.calls[0][0]).toMatchObject({ method: "PATCH" });
    // The client asserts nothing about which steps block: it asks, and reports
    // what it is told. That is the point of #247 — the server holds the answer.
    expect(JSON.parse(patched.mock.calls[0][0].body as string)).toEqual({
      action: "finish",
    });
  });
});
