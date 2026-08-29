// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type {
  SetupWizardEnvironmentSafety,
  SetupWizardView,
} from "@/lib/setup-wizard-view";
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
  environment: SetupWizardView["environment"] = [],
): SetupWizardView {
  return {
    groups: [],
    steps: [],
    environment,
    // D17 (#246): derived from the rows the caller supplied, so a test cannot
    // set up a view where a row says it blocks and the list disagrees — the
    // real `buildSetupWizardView` cannot produce one either.
    launchBlockedBy: environment.filter((row) => row.blocksLaunch),
    percentComplete: 100,
    currentStepId: null,
    navigationFrontierStepId: null,
    allResolved: true,
    outstanding,
  };
}

/** One environment row, defaulting to a green one that holds nothing shut. */
function environmentRow(
  overrides: Partial<SetupWizardView["environment"][number]> = {},
): SetupWizardView["environment"][number] {
  return {
    id: "runtime-env" as SetupStepId,
    title: "Runtime Environment",
    description: "The deployment's own variables.",
    status: "complete",
    blocksLaunch: false,
    message: "Required runtime variables are present and well formed.",
    details: [],
    remedy: null,
    permissionArea: "support",
    ...overrides,
  };
}

const contentEditor = { ...emptyAdminPermissionMatrix(), content: "edit" as const };

/** UNKNOWN, nothing withheld — the fail-closed default the route itself falls
 * back to when the snapshot carries no environment-role answer. */
const unknownSafety: SetupWizardEnvironmentSafety = {
  role: "UNKNOWN",
  decidedBy: "unresolved",
  withheldEmail: { available: false },
};

function renderPanel(
  overrides: Partial<Parameters<typeof SetupWizardLaunchPanel>[0]> = {},
) {
  const onPublishActivity = vi.fn();
  render(
    <SetupWizardLaunchPanel
      view={viewWith()}
      isSiteVisible={false}
      environmentSafety={unknownSafety}
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
        { id: "seasons-rates" as SetupStepId, title: "Seasons And Rates", deferred: true },
      ]),
    });
    const outstanding = screen.getByTestId("setup-wizard-outstanding");
    expect(outstanding.textContent).toContain("Seasons And Rates");
    expect(outstanding.textContent).toContain("skipped for now");
    // Nothing unchosen, so the second list is absent entirely.
    expect(screen.queryByTestId("setup-wizard-outstanding-unchosen")).toBeNull();
  });

  /*
    "BY YOUR OWN CHOICE" IS A CLAIM, AND IT IS NOT ALWAYS TRUE OF THE WHOLE LIST
    (#237 fix round). `launchPinned` in the shell keeps this panel mounted across
    a refetch — it must, or a publish in flight would unmount mid-request — so a
    step that has gone stale, or one a newly-enabled module contributes, can
    arrive in `outstanding` having been chosen by nobody. Under the old single
    heading the operator was told they had skipped something they had never seen.

    Mutation-verified: rendering `view.outstanding` under the one heading again
    fails this.
  */
  it("does not claim an unchosen outstanding step was skipped", () => {
    stubPublishFetch();
    renderPanel({
      view: viewWith([
        { id: "seasons-rates" as SetupStepId, title: "Seasons And Rates", deferred: true },
        {
          id: "club-time-zone" as SetupStepId,
          title: "Club Time Zone",
          deferred: false,
        },
      ]),
    });

    const chosen = screen.getByTestId("setup-wizard-outstanding");
    expect(chosen.textContent).toContain("Seasons And Rates");
    expect(chosen.textContent).not.toContain("Club Time Zone");

    const unchosen = screen.getByTestId("setup-wizard-outstanding-unchosen");
    expect(unchosen.textContent).toContain("Club Time Zone");
    expect(unchosen.textContent).not.toContain("Seasons And Rates");
    expect(unchosen.textContent).toMatch(/not by your choice/i);
    expect(unchosen.textContent).toMatch(/nothing here was skipped/i);
  });

  it("renders only the unchosen list when nothing was skipped", () => {
    stubPublishFetch();
    renderPanel({
      view: viewWith([
        {
          id: "club-time-zone" as SetupStepId,
          title: "Club Time Zone",
          deferred: false,
        },
      ]),
    });

    expect(screen.queryByTestId("setup-wizard-outstanding")).toBeNull();
    expect(
      screen.getByTestId("setup-wizard-outstanding-unchosen").textContent,
    ).toContain("Club Time Zone");
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
  /*
    D17's PUBLISH GATE (#246).

    Mutation-verified: dropping `environmentBlocksPublish` from the button's
    `disabled` leaves every one of these failing. That probe is why they exist —
    the gate shipped with no unit coverage at all until it was run.
  */
  it("REFUSES THE PUBLISH while an environment fact holds the site shut", () => {
    const { post } = stubPublishFetch();
    renderPanel({
      view: viewWith(
        [],
        [
          environmentRow({
            id: "environment-role" as SetupStepId,
            title: "Production Or Non-Production",
            status: "blocked",
            blocksLaunch: true,
            message: "Nothing says whether this installation is the live site.",
            remedy: {
              who: "Whoever runs your server sets this.",
              send: "Set APP_ENVIRONMENT_ROLE and restart.",
              why: "A copy that publishes emails real members.",
            },
          }),
        ],
      ),
    });
    const button = screen.getByTestId(
      "setup-wizard-make-site-visible",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(post).not.toHaveBeenCalled();
  });

  it("says WHY the publish is refused, and whose job it is", () => {
    // An operator at a disabled button is asking one question. Answering it
    // only on the environment panel would make them go looking.
    stubPublishFetch();
    renderPanel({
      view: viewWith(
        [],
        [
          environmentRow({
            id: "environment-role" as SetupStepId,
            title: "Production Or Non-Production",
            status: "blocked",
            blocksLaunch: true,
            remedy: {
              who: "Whoever runs your server sets this.",
              send: "Set APP_ENVIRONMENT_ROLE and restart.",
              why: "A copy that publishes emails real members.",
            },
          }),
        ],
      ),
    });
    const notice = screen.getByTestId(
      "setup-wizard-launch-environment-blocked",
    );
    expect(notice.textContent).toContain("Production Or Non-Production");
    expect(notice.textContent).toContain("Whoever runs your server");
    // …and points at the screen that carries the line to send.
    expect(notice.textContent).toContain("About this server");
  });

  it("STILL RENDERS THE PANEL when the publish is refused", () => {
    // The reason the gate is on the button and not on `allResolved`: an
    // operator refused a publish must still be able to read the refusal.
    stubPublishFetch();
    renderPanel({
      view: viewWith(
        [],
        [
          environmentRow({
            status: "blocked",
            blocksLaunch: true,
            remedy: {
              who: "Whoever runs your server fixes this.",
              send: "Set CRON_SECRET and restart.",
              why: "Nothing overnight runs.",
            },
          }),
        ],
      ),
    });
    expect(screen.getByTestId("setup-wizard-launch-panel")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /Ready to open/i }),
    ).toBeTruthy();
  });

  it("publishes normally when the facts are amber but non-gating", () => {
    // email-ses and sentry: worth an amber row, never a reason to keep a club
    // shut. A gate that fired on any non-green fact would block every club
    // without Sentry, which is most of them.
    const { post } = stubPublishFetch();
    renderPanel({
      view: viewWith(
        [],
        [
          environmentRow({
            id: "sentry" as SetupStepId,
            status: "warning",
            blocksLaunch: false,
            remedy: {
              who: "Optional.",
              send: "Set the SENTRY_* variables.",
              why: "Diagnostics only.",
            },
          }),
        ],
      ),
    });
    const button = screen.getByTestId(
      "setup-wizard-make-site-visible",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(
      screen.queryByTestId("setup-wizard-launch-environment-blocked"),
    ).toBeNull();
    fireEvent.click(button);
    expect(post).toHaveBeenCalled();
  });

  it("shows no refusal notice on a site that is already live", () => {
    stubPublishFetch();
    renderPanel({
      isSiteVisible: true,
      view: viewWith(
        [],
        [environmentRow({ status: "blocked", blocksLaunch: true })],
      ),
    });
    // Publishing has already happened; telling somebody they cannot do a thing
    // they have done is noise.
    expect(
      screen.queryByTestId("setup-wizard-launch-environment-blocked"),
    ).toBeNull();
  });

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

  /**
   * What "no control" actually has to mean (D2, #224 fix round). Counting only
   * `<button>` missed the codebase's real acknowledge-control precedent: a
   * `Checkbox` (`src/components/ui/checkbox.tsx`) renders a native
   * `<input type="checkbox">`, not a button, and there is no `Switch`
   * component in this repository to worry about instead. So the guard queries
   * every element shape that can mutate or acknowledge something —
   * `button`, `input`, `select`, `textarea`, and the ARIA roles a
   * non-native control could carry (`[role="button"]`, `[role="switch"]`,
   * `[role="checkbox"]`) — and separately pins the section to exactly one
   * anchor, pointed at `/admin/environment`: a link navigates rather than
   * mutating, so an `<a>` is not a control, but a SECOND one smuggled in would
   * still be worth catching.
   */
  const NO_CONTROL_SELECTOR =
    'button, input, select, textarea, [role="button"], [role="switch"], [role="checkbox"]';

  it("keeps the environment-role lever consume-only and independent", () => {
    stubPublishFetch();
    renderPanel();
    const role = screen.getByTestId("setup-wizard-environment-role");
    // It instructs (D9: production is declared in `.env` by upstream design)
    // and offers no control at all.
    expect(role.textContent).toContain(".env");
    expect(role.querySelectorAll(NO_CONTROL_SELECTOR).length).toBe(0);
    const anchors = role.querySelectorAll("a");
    expect(anchors.length).toBe(1);
    expect(anchors[0].getAttribute("href")).toBe("/admin/environment");
    // …and it does not gate the other lever.
    expect(screen.getByTestId("setup-wizard-make-site-visible")).toBeTruthy();
  });

  // C9 (#224): no control on ANY role — not just the UNKNOWN default above.
  // Mutation-verified: adding a `Checkbox` (or any bare `<input>`) anywhere in
  // `EnvironmentRoleSection` fails one of these three (D2, #224 fix round).
  it.each([
    ["PRODUCTION", "deployment-declaration"],
    ["NON_PRODUCTION", "database-safer-override"],
    ["UNKNOWN", "unresolved"],
  ] as const)(
    "offers no control while role is %s",
    (role, decidedBy) => {
      stubPublishFetch();
      renderPanel({
        environmentSafety: {
          role,
          decidedBy,
          withheldEmail: { available: false },
        },
      });
      const section = screen.getByTestId("setup-wizard-environment-role");
      expect(section.querySelectorAll(NO_CONTROL_SELECTOR).length).toBe(0);
      const anchors = section.querySelectorAll("a");
      expect(anchors.length).toBe(1);
      expect(anchors[0].getAttribute("href")).toBe("/admin/environment");
    },
  );

  // AC: role + source + withheld count, from the SAME payload the wizard
  // route reads — never re-derived in this component.
  it("names the role and which source decided it", () => {
    stubPublishFetch();
    renderPanel({
      environmentSafety: {
        role: "NON_PRODUCTION",
        decidedBy: "database-safer-override",
        withheldEmail: { available: false },
      },
    });
    const role = screen.getByTestId("setup-wizard-environment-role");
    expect(role.textContent).toContain("Non-production");
    expect(role.textContent).toContain("safer override");
  });

  // AC: WHERE role is UNKNOWN, the D9 guiding banner names what is paused and
  // where to declare it, and invents no reading of its own.
  it("shows the UNKNOWN guiding banner naming what is paused and the declare path", () => {
    stubPublishFetch();
    renderPanel({ environmentSafety: unknownSafety });
    const banner = screen.getByTestId("setup-wizard-environment-role-unknown");
    expect(banner.textContent).toContain("paused");
    expect(banner.textContent).toContain("APP_ENVIRONMENT_ROLE");
    expect(banner.textContent).toContain(".env");
  });

  // …and never once a role IS declared, whichever way.
  it.each([
    ["PRODUCTION", "deployment-declaration"],
    ["NON_PRODUCTION", "deployment-declaration"],
  ] as const)("shows no UNKNOWN banner while role is %s", (role, decidedBy) => {
    stubPublishFetch();
    renderPanel({
      environmentSafety: { role, decidedBy, withheldEmail: { available: false } },
    });
    expect(
      screen.queryByTestId("setup-wizard-environment-role-unknown"),
    ).toBeNull();
  });

  // AC: WHERE non-production, the section names the containment (email + Xero)
  // in plain language.
  it("names what is contained on a non-production installation", () => {
    stubPublishFetch();
    renderPanel({
      environmentSafety: {
        role: "NON_PRODUCTION",
        decidedBy: "deployment-declaration",
        withheldEmail: { available: false },
      },
    });
    const role = screen.getByTestId("setup-wizard-environment-role");
    expect(role.textContent).toContain("no email to members");
    expect(role.textContent).toContain("Xero");
  });

  // AC: the four upstream outcome kinds render distinguishably rather than
  // collapsing to a binary (suppressed / blocked / failed / business-withheld —
  // see `describeWithheldEmail` in the panel for the mapping).
  it("renders SUPPRESSED for a confirmed copy's held-back count", () => {
    stubPublishFetch();
    renderPanel({
      environmentSafety: {
        role: "NON_PRODUCTION",
        decidedBy: "deployment-declaration",
        withheldEmail: {
          available: true,
          count: 5,
          mostRecentAt: null,
          captureInProduction: 0,
        },
      },
    });
    const role = screen.getByTestId("setup-wizard-environment-role");
    expect(role.textContent).toContain("SUPPRESSED");
    expect(role.textContent).not.toContain("BLOCKED");
  });

  it("renders BLOCKED for an undeclared installation's held-back count", () => {
    stubPublishFetch();
    renderPanel({
      environmentSafety: {
        role: "UNKNOWN",
        decidedBy: "unresolved",
        withheldEmail: {
          available: true,
          count: 5,
          mostRecentAt: null,
          captureInProduction: 0,
        },
      },
    });
    const role = screen.getByTestId("setup-wizard-environment-role");
    expect(role.textContent).toContain("BLOCKED");
    expect(role.textContent).not.toContain("SUPPRESSED");
  });

  it("renders FAILED for a live site that also declares a mail capture", () => {
    stubPublishFetch();
    renderPanel({
      environmentSafety: {
        role: "PRODUCTION",
        decidedBy: "deployment-declaration",
        withheldEmail: {
          available: true,
          count: 2,
          mostRecentAt: null,
          captureInProduction: 2,
        },
      },
    });
    const role = screen.getByTestId("setup-wizard-environment-role");
    expect(role.textContent).toContain("FAILED");
    expect(role.textContent).toContain("USE_LOCAL_CAPTURE");
  });

  // F1 (#224 fix round): a confirmed live site with a historical total but NO
  // current capture-in-production fault renders no withheld-email row at all —
  // matching `setup-readiness.ts`'s own rule, "Not rendered for PRODUCTION,
  // where nothing is held back for this reason and the line would be noise."
  // `count` here is deliberately non-zero (terminal `SKIPPED_NON_PRODUCTION`
  // rows from a former life as a copy persist forever) to prove the row is
  // gone because of `captureInProduction`, not because the total happens to be
  // zero.
  it("renders no withheld-email row for PRODUCTION with a clean current count", () => {
    stubPublishFetch();
    renderPanel({
      environmentSafety: {
        role: "PRODUCTION",
        decidedBy: "deployment-declaration",
        withheldEmail: {
          available: true,
          count: 40,
          mostRecentAt: null,
          captureInProduction: 0,
        },
      },
    });
    const role = screen.getByTestId("setup-wizard-environment-role");
    expect(
      screen.queryByText("Application email held back for environment safety"),
    ).toBeNull();
    expect(role.textContent).not.toContain("FAILED");
    expect(role.textContent).not.toContain("BOTH the live site and a mail capture");
  });

  // F2 (#224 fix round): a CONFIRMED, correctly-declared copy carrying a
  // historical `captureInProduction` count from its life as production before
  // being restored — the epic's core premise — reads SUPPRESSED, never the
  // "BOTH the live site and a mail capture" wording, because that count is not
  // this installation's current fault under a non-production role.
  it("reads SUPPRESSED, not FAILED, for a confirmed copy carrying a historical capture-in-production count", () => {
    stubPublishFetch();
    renderPanel({
      environmentSafety: {
        role: "NON_PRODUCTION",
        decidedBy: "deployment-declaration",
        withheldEmail: {
          available: true,
          count: 12,
          mostRecentAt: null,
          captureInProduction: 12,
        },
      },
    });
    const role = screen.getByTestId("setup-wizard-environment-role");
    expect(role.textContent).toContain("SUPPRESSED");
    expect(role.textContent).not.toContain("FAILED");
    expect(role.textContent).not.toContain("BOTH the live site and a mail capture");
  });

  it("names business-withheld as a separate, uncounted concept", () => {
    stubPublishFetch();
    renderPanel({
      environmentSafety: {
        role: "NON_PRODUCTION",
        decidedBy: "deployment-declaration",
        withheldEmail: {
          available: true,
          count: 5,
          mostRecentAt: null,
          captureInProduction: 0,
        },
      },
    });
    const role = screen.getByTestId("setup-wizard-environment-role");
    expect(role.textContent).toContain("No emails");
    expect(role.textContent).toContain("per-booking");
  });

  it("links to Admin › Environment", () => {
    stubPublishFetch();
    renderPanel();
    const role = screen.getByTestId("setup-wizard-environment-role");
    const link = role.querySelector("a[href='/admin/environment']");
    expect(link).toBeTruthy();
  });
});
