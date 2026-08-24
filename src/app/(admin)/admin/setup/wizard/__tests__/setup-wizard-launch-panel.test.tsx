// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardView } from "@/lib/setup-wizard-view";
import { SetupWizardLaunchPanel } from "@/app/(admin)/admin/setup/wizard/setup-wizard-launch-panel";

/**
 * The launch panel (epic #213, **D9**): two independent levers, and outstanding
 * work stated rather than hidden.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The publish endpoint, and NOTHING else — the panel reads no theme at all now,
 * so a stubbed fetch that answers anything but this call is a test asserting
 * against a request the component must never make.
 */
function stubPublishFetch(options: { ok?: boolean } = {}) {
  const post = vi.fn();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    post({ url: String(url), method: init?.method, body: init?.body });
    const ok = options.ok ?? true;
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () =>
        ok
          ? { isComplete: true }
          : { error: "Failed to make the public site visible" },
    };
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return { post, fetchMock };
}

function viewWith(
  outstanding: SetupWizardView["outstanding"] = [],
): SetupWizardView {
  return {
    groups: [],
    steps: [],
    percentComplete: 100,
    currentStepId: null,
    navigationFrontierStepId: null,
    allResolved: true,
    outstanding,
  };
}

const contentEditor = { ...emptyAdminPermissionMatrix(), content: "edit" as const };

function renderPanel(
  overrides: Partial<Parameters<typeof SetupWizardLaunchPanel>[0]> = {},
) {
  const onPublishActivity = vi.fn();
  render(
    <SetupWizardLaunchPanel
      view={viewWith()}
      isSiteVisible={false}
      permissionMatrix={contentEditor}
      onPublishActivity={onPublishActivity}
      {...overrides}
    />,
  );
  return { onPublishActivity };
}

describe("SetupWizardLaunchPanel", () => {
  it("states what the club skipped rather than hiding it (mockup 6)", () => {
    stubPublishFetch();
    renderPanel({
      view: viewWith([
        { id: "sentry" as SetupStepId, title: "Error Monitoring", deferred: true },
      ]),
    });
    const outstanding = screen.getByTestId("setup-wizard-outstanding");
    expect(outstanding.textContent).toContain("Error Monitoring");
    expect(outstanding.textContent).toContain("skipped for now");
  });

  // #220 review F3. The old panel GET the whole club theme on mount and PUT it
  // all back with `completeSetup: true`, which wrote a stale copy of the
  // colours over a concurrent administrator's edit. The one column it means to
  // change now has its own endpoint, and this panel sends no theme at all.
  it("publishes through the one-column endpoint, carrying no theme", async () => {
    const { post } = stubPublishFetch();
    renderPanel();
    fireEvent.click(screen.getByTestId("setup-wizard-make-site-visible"));
    await waitFor(() => expect(post).toHaveBeenCalled());

    // ONE request, and it is the publish. Anything else here would be the panel
    // reading a theme again.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toEqual({
      url: "/api/admin/site-style/complete-setup",
      method: "POST",
      body: undefined,
    });
    expect(await screen.findByText(/The public site is live/)).toBeTruthy();
  });

  // D12. Mutation-verified: dropping `canEdit` from the lever's
  // ViewOnlyActionButton fails this test.
  it("gives an officer without content edit no way to publish the site", () => {
    const { post } = stubPublishFetch();
    renderPanel({
      permissionMatrix: { ...emptyAdminPermissionMatrix(), content: "view" },
    });
    const button = screen.getByTestId(
      "setup-wizard-make-site-visible",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId("admin-view-only-banner").textContent).toContain(
      ADMIN_VIEW_ONLY_SECTION_HEADING,
    );
  });

  // The visibility display is now a PROP off the wizard payload, which the
  // shell refetches on focus — so it follows the club rather than freezing at
  // whatever the panel's own fetch saw when it mounted.
  it("reports an already-visible site from the payload, not from its own fetch", () => {
    const { post } = stubPublishFetch();
    renderPanel({ isSiteVisible: true });
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.queryByTestId("setup-wizard-make-site-visible")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("tells the shell to hold the panel while a publish is in flight", async () => {
    stubPublishFetch();
    const { onPublishActivity } = renderPanel();
    fireEvent.click(screen.getByTestId("setup-wizard-make-site-visible"));
    // Announced SYNCHRONOUSLY on the click, before the request settles — that
    // is the window in which a refetch could otherwise unmount the panel and
    // discard the result.
    expect(onPublishActivity).toHaveBeenCalledWith(true);
    expect(await screen.findByText(/The public site is live/)).toBeTruthy();
    // …and never released by the panel itself: the shell drops the pin when the
    // operator navigates away, once they have read the answer.
    expect(onPublishActivity).not.toHaveBeenCalledWith(false);
  });

  it("keeps a failed publish on screen with its reason, still pinned", async () => {
    stubPublishFetch({ ok: false });
    const { onPublishActivity } = renderPanel();
    fireEvent.click(screen.getByTestId("setup-wizard-make-site-visible"));
    expect(
      await screen.findByText(/Failed to make the public site visible/),
    ).toBeTruthy();
    // Still offered, because it did not happen.
    expect(screen.getByTestId("setup-wizard-make-site-visible")).toBeTruthy();
    // Pinned through the failure too — an error nobody can read is no better
    // than a success nobody can read.
    expect(onPublishActivity).toHaveBeenCalledWith(true);
    expect(onPublishActivity).not.toHaveBeenCalledWith(false);
  });

  it("keeps the environment-role lever consume-only and independent", () => {
    stubPublishFetch();
    renderPanel();
    const role = screen.getByTestId("setup-wizard-environment-role");
    // It instructs (D9: production is declared in `.env` by upstream design)
    // and offers no control at all.
    expect(role.textContent).toContain(".env");
    expect(role.querySelectorAll("button").length).toBe(0);
    // …and it does not gate the other lever.
    expect(screen.getByTestId("setup-wizard-make-site-visible")).toBeTruthy();
  });
});
