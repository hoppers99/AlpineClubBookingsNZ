// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `ModulesSection`'s own focus/visibility refetch (F3, #239 fix round).
 *
 * Before this, the section fetched once on mount and never again, while the
 * setup wizard's rail beside it (mounted as `ModulesWizardPane`'s sibling,
 * `setup-wizard-panes.tsx`) live-updates on the exact same triggers
 * (`setup-wizard-client.tsx`). Left open across a whole setup session — the
 * long-lived case C13 (#239) created by putting this section inside the
 * wizard — a second admin's save in another tab could change these flags
 * while this one still shows the stale checkboxes, and the full-record PUT
 * below would then silently revert that admin's change the next time Save is
 * pressed here.
 *
 * These two tests pin the fix's own narrowness: it refetches when the tab
 * regains focus/visibility AND the section is clean, and it holds off while
 * an operator has an unsaved draft — the wizard shell's own trigger shape,
 * mirrored (`setup-wizard-client.tsx`'s focus/visibilitychange listener).
 */

const mocks = vi.hoisted(() => ({
  canEdit: vi.fn<() => boolean | undefined>(() => true),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { MODULE_DEFINITIONS, MODULE_KEYS, type ModuleSettingsValues } from "@/config/modules";
import { ModulesSection } from "@/app/(admin)/admin/modules/modules-section";

const ALL_MODULES_OFF = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, false]),
) as ModuleSettingsValues;

const XERO_LABEL = MODULE_DEFINITIONS.xeroIntegration.label;

/** What `GET`/`PUT /api/admin/modules` answers, in the route's own shape. */
function modulesPayload(settings: ModuleSettingsValues) {
  return {
    settings,
    modules: MODULE_KEYS.map((key) => ({
      key,
      label: MODULE_DEFINITIONS[key].label,
      description: MODULE_DEFINITIONS[key].description,
      adminEnabled: settings[key],
      effectiveEnabled: settings[key],
      readiness: {
        status: settings[key] ? "ready" : "admin_disabled",
        message: settings[key] ? "on" : "off",
        dependencies: [],
      },
    })),
    updatedAt: null,
    updatedByMemberId: null,
  };
}

function stubModulesFetch(initial: Partial<ModuleSettingsValues> = {}) {
  const settings = { ...ALL_MODULES_OFF, ...initial } as ModuleSettingsValues;
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => modulesPayload(settings),
  }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function getRequestCount(fetchMock: ReturnType<typeof stubModulesFetch>) {
  return fetchMock.mock.calls.length;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModulesSection focus/visibility refetch", () => {
  it("refetches when the tab regains focus and the section is clean", async () => {
    const fetchMock = stubModulesFetch();
    render(<ModulesSection />);

    await screen.findByRole("checkbox", { name: XERO_LABEL });
    const requestsAfterMount = getRequestCount(fetchMock);

    fireEvent.focus(window);
    await waitFor(() => expect(getRequestCount(fetchMock)).toBeGreaterThan(requestsAfterMount));
  });

  it("refetches on visibilitychange too, when visible and clean", async () => {
    const fetchMock = stubModulesFetch();
    render(<ModulesSection />);

    await screen.findByRole("checkbox", { name: XERO_LABEL });
    const requestsAfterMount = getRequestCount(fetchMock);

    // jsdom's default `document.visibilityState` is "visible", matching the
    // ordinary "came back to this tab" case the listener exists for.
    expect(document.visibilityState).toBe("visible");
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(getRequestCount(fetchMock)).toBeGreaterThan(requestsAfterMount));
  });

  it("does NOT refetch while an unsaved draft is pending — a background read must never clobber it", async () => {
    const fetchMock = stubModulesFetch();
    render(<ModulesSection />);

    const xero = await screen.findByRole("checkbox", { name: XERO_LABEL });
    fireEvent.click(xero); // dirty: draft now differs from the loaded settings
    expect(xero).toBeChecked();

    const requestsAfterEdit = getRequestCount(fetchMock);
    fireEvent.focus(window);

    // Give any (wrongly-fired) refetch a turn of the event loop to land, then
    // confirm nothing did: no new request, and the draft edit is still there.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getRequestCount(fetchMock)).toBe(requestsAfterEdit);
    expect(xero).toBeChecked();
  });
});
