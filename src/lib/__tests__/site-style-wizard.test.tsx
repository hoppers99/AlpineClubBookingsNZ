// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SiteStyleWizard } from "@/app/(admin)/admin/site-style/site-style-wizard";
import {
  DEFAULT_CLUB_THEME_VALUES,
  type ClubThemeValues,
} from "@/lib/club-theme-schema";
import { SITE_VISIBILITY_UNKNOWN_ROLE_ERROR } from "@/lib/site-visibility-gate";

const fetchMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

// The wizard now gates its controls on content:edit (#1927); render as a
// content:edit admin so these existing behaviour tests keep exercising the
// editable path.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
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
  }),
}));

function responseTheme(values: ClubThemeValues, completedAt: string | null) {
  return {
    theme: {
      ...values,
      completedAt,
      contrastWarnings: [],
    },
  };
}

// Full-wizard jsdom renders routinely exceed vitest's 5s default under
// parallel full-suite load; same ceiling as site-style-wizard-upload.test.tsx.
vi.setConfig({ testTimeout: 45_000 });

describe("site style wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(
          String(init?.body ?? "{}"),
        ) as ClubThemeValues & {
          completeSetup?: boolean;
        };
        return {
          ok: true,
          json: async () =>
            responseTheme(
              {
                brandGold: body.brandGold,
                brandDeep: body.brandDeep,
                brandSafety: body.brandSafety,
                headingFontKey: body.headingFontKey,
                bodyFontKey: body.bodyFontKey,
                logoUrl: body.logoUrl,
                logoDataUrl: body.logoDataUrl,
                rawCss: body.rawCss ?? "",
              },
              body.completeSetup ? "2026-06-11T12:00:00.000Z" : null,
            ),
        };
      },
    );
  });

  it("saves each step and finishes setup", async () => {
    render(
      <SiteStyleWizard legacySurfacesHidden={false} initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          completedAt: null,
          contrastWarnings: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Fonts" });

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Raw CSS" });

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Logo" });

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Review" });

    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(screen.getByText("Site style is complete.")).toBeTruthy();
    });
    const lastCallBody = JSON.parse(
      String(fetchMock.mock.calls.at(-1)?.[1]?.body ?? "{}"),
    );
    expect(lastCallBody.completeSetup).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(refreshMock).toHaveBeenCalledTimes(5);
  }, 45_000);

  /*
    Epic #213, C8 (#223), executing the binding 25 Aug addition to that issue.
    This page's "Finish setup" is the SECOND lever that makes the public site
    visible — the same audited `completeSetup` write the wizard's Ready-to-open
    panel makes — so it retires with the legacy setup surfaces, leaving D9's
    launch panel as the one deliberate act.

    WHAT RETIRES IS THE FINISHING, NOT THE SAVING. The assertion that matters is
    the payload: the last step still writes the styling, and it writes it with
    `completeSetup: false`. Hiding the button outright would have taken away the
    only way to persist the final step's changes, which is removing a capability
    rather than relocating one.
  */
  it("saves without finishing when the legacy setup surfaces are hidden (#223)", async () => {
    render(
      <SiteStyleWizard legacySurfacesHidden={true} initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          completedAt: null,
          contrastWarnings: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Fonts" });
    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Raw CSS" });
    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Logo" });
    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByRole("heading", { name: "Review" });

    // The finish affordance is gone by NAME, which is what an operator sees…
    expect(screen.queryByRole("button", { name: "Finish setup" })).toBeNull();
    // …and the save that replaced it is there.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Site style saved.")).toBeTruthy();
    });
    const lastCallBody = JSON.parse(
      String(fetchMock.mock.calls.at(-1)?.[1]?.body ?? "{}"),
    );
    // The assertion this test exists for: nothing published the site.
    expect(lastCallBody.completeSetup).toBe(false);
  }, 45_000);

  /*
    THE THIRD CLIENT OF THE PUBLISH REFUSAL (epic #213, C16/#247;
    INV-CONFIG-006). The wizard's launch panel and the complete-setup route have
    their own coverage; this page is the OTHER lever that publishes the site, and
    nothing pinned that its operator ever sees why the refusal happened.

    It matters here more than at the other two, because this component owns a
    403 branch of its own. A `!response.ok` that is NOT 403 has to fall through
    to `responseErrorMessage(body, …)` and render the SERVER's text; one wrong
    `else` and a content officer publishing from an undeclared installation is
    told "Failed to save site style" — true, useless, and naming none of the
    three repairs.

    The assertion is the whole imported constant rather than a fragment, which is
    what makes it an end-to-end pin: this is a message the client could not have
    produced, so seeing it on screen proves the server's text travelled the whole
    way.
  */
  it("surfaces the server's publish refusal verbatim on a 409 (#247)", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: SITE_VISIBILITY_UNKNOWN_ROLE_ERROR }),
    }));

    render(
      <SiteStyleWizard legacySurfacesHidden={false} initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          completedAt: null,
          contrastWarnings: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));

    await waitFor(() => {
      expect(screen.getByText(SITE_VISIBILITY_UNKNOWN_ROLE_ERROR)).toBeTruthy();
    });
    // A 409 is a conflict with the state of the INSTALLATION, not a permission
    // failure — the caller holds `content: edit`, and the same request succeeds
    // once the role is declared. The admin forbidden notice says the opposite,
    // and would send somebody to ask for access they already have.
    expect(screen.queryByText(/do not have permission/i)).toBeNull();
    // Nothing was published, so nothing may report success.
    expect(screen.queryByText("Site style is complete.")).toBeNull();
    expect(screen.queryByText("Site style saved.")).toBeNull();
  }, 45_000);

  it("explains and previews the editable brand and fixed semantic layers", () => {
    render(
      <SiteStyleWizard legacySurfacesHidden={false} initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          completedAt: "2026-07-12T00:00:00.000Z",
          contrastWarnings: [],
        }}
      />,
    );

    expect(screen.getByText("Editable brand layer")).toBeTruthy();
    expect(screen.getByText("Fixed semantic layer")).toBeTruthy();
    expect(screen.getByText("Member + admin app preview")).toBeTruthy();
    expect(screen.getByText("Success")).toBeTruthy();
    expect(screen.getByText("Danger")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Occupancy: 18 of 30 bunks filled",
    );
  });

  it("keeps Save enabled and discloses generator adjustments instead of blocking on contrast (#2187)", async () => {
    render(
      <SiteStyleWizard legacySurfacesHidden={false} initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          completedAt: null,
          contrastWarnings: [],
        }}
      />,
    );

    // A near-identical accent/neutral pair that the old blocking contrast gate
    // ("Contrast too low to save") would have rejected. Contrast is now
    // guaranteed by construction, so the seed is adjusted, never blocked.
    fireEvent.change(screen.getByLabelText("Neutral character value"), {
      target: { value: DEFAULT_CLUB_THEME_VALUES.brandGold },
    });

    // The generator's accessibility nudge is disclosed (before → after), and
    // the palette still saves — Save stays enabled.
    await screen.findByText(/Colours adjusted for accessibility/);
    expect(
      (screen.getByRole("button", { name: "Save and next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
