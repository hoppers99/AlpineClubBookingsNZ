// @vitest-environment jsdom

/**
 * Activating a lodge from its own setup flow (#221, epic #213 C6).
 *
 * A lodge created through `POST /api/admin/lodges` now starts inactive, so this
 * flow's finish step is where it becomes bookable. What is pinned here is that
 * the affordance exists, that it appears only while the lodge is closed, and —
 * the part that matters most — that it goes through the EXISTING
 * `PATCH /api/admin/lodges/[id]` rather than growing a second write surface.
 * That route is what audits `LODGE_ACTIVATED` and takes the config-import and
 * per-lodge capacity locks; a bespoke endpoint here would have neither.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

/*
  The lodge area's level is mutable so the view-only case can be exercised
  against the SAME finish step the edit case reaches. It has to be: a view-only
  admin cannot walk the flow at all — the identity step's only forward control
  is its gated "Save and continue" — so the honest way to stand a view-only
  admin in front of the activation button is to arrive there and then narrow the
  permission, which is also the real-world shape (a role edited under a tab that
  is already open).
*/
const session = vi.hoisted(() => ({ lodgeLevel: "edit" as "edit" | "view" }));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        accessRoles: ["ADMIN"],
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: session.lodgeLevel,
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "lodge-7" }),
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  session.lodgeLevel = "edit";
});

type FetchCall = { url: string; method: string; body: unknown };

function stubFetch(lodge: { active: boolean }, calls: FetchCall[]) {
  let active = lodge.active;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "/api/admin/lodges") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            lodges: [
              { id: "lodge-7", name: "Alpine Hut", slug: "alpine-hut", active },
            ],
          }),
        };
      }
      if (url === "/api/admin/modules") {
        return { ok: true, status: 200, json: async () => ({ settings: {} }) };
      }
      if (url.startsWith("/api/admin/lodges/lodge-7") && method === "PATCH") {
        // The identity step PATCHes this same route, so only an explicit
        // `{ active: true }` may flip the flag — otherwise saving a name would
        // silently open the lodge and this file would be proving nothing.
        const patched = init?.body ? JSON.parse(String(init.body)) : {};
        if (patched.active === true) active = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            lodge: {
              id: "lodge-7",
              name: "Alpine Hut",
              slug: "alpine-hut",
              active,
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

// Re-renders the page in place, so a permission change is picked up without
// remounting (which would reset the wizard to step one).
let rerenderPage: () => void = () => {};

async function renderFinishStep(lodge: { active: boolean }) {
  const calls: FetchCall[] = [];
  stubFetch(lodge, calls);
  const LodgeSetupWizardPage = (
    await import("@/app/(admin)/admin/lodges/[id]/setup/page")
  ).default;
  const { rerender } = render(<LodgeSetupWizardPage />);
  rerenderPage = () => rerender(<LodgeSetupWizardPage />);
  // Walk to the last step. Every intermediate step is skippable by design, so
  // the forward control is the whole traversal — but the identity step SAVES
  // before it advances, so each click has to settle before the next is looked
  // for, or the loop spends its clicks on a disabled "Saving..." button.
  await screen.findByText("Lodge identity");
  for (let i = 0; i < 8; i += 1) {
    const heading = screen.getByRole("heading", { level: 1 }).textContent;
    const next = screen
      .queryAllByRole("button")
      .find(
        (button) =>
          /^(Skip for now|Continue|Save and continue|Next)$/.test(
            button.textContent?.trim() ?? "",
          ) && !(button as HTMLButtonElement).disabled,
      );
    if (!next) break;
    fireEvent.click(next);
    await waitFor(() => {
      expect(
        screen.queryByTestId("lodge-setup-activate") ??
          screen.queryByText("All set") ??
          (screen.getByRole("heading", { level: 1 }).textContent !== heading
            ? screen.getByRole("heading", { level: 1 })
            : null) ??
          screen
            .queryAllByRole("button")
            .find(
              (button) =>
                (button.textContent?.trim() ?? "") === "Skip for now" &&
                !(button as HTMLButtonElement).disabled,
            ),
      ).toBeTruthy();
    });
    if (
      screen.queryByTestId("lodge-setup-activate") ||
      screen.queryByText("All set")
    ) {
      break;
    }
  }
  return calls;
}

describe("the per-lodge setup flow activates the lodge (#221)", () => {
  it("offers activation on the finish step while the lodge is closed", async () => {
    const calls = await renderFinishStep({ active: false });

    // Said up front, not only at the end.
    expect(screen.getByTestId("lodge-setup-inactive-notice").textContent).toContain(
      "not open for booking yet",
    );

    const activate = await screen.findByTestId("lodge-setup-activate");
    // Only the requests this click makes — the identity step PATCHes the same
    // route on its way past, and crediting that to the Activate button would
    // let this test pass with the button doing nothing at all.
    const before = calls.length;
    fireEvent.click(activate);

    await waitFor(() => {
      const patch = calls.slice(before).find((call) => call.method === "PATCH");
      expect(patch).toBeDefined();
      // THE POINT: the ordinary lodge PATCH, not a new endpoint. That route
      // audits LODGE_ACTIVATED and takes the config-import plus per-lodge
      // capacity locks; anything bespoke here would take neither.
      expect(patch?.url).toBe("/api/admin/lodges/lodge-7");
      expect(patch?.body).toEqual({ active: true });
    });

    // Once activated the affordance goes, and the notice with it.
    await waitFor(() => {
      expect(screen.queryByTestId("lodge-setup-activate")).toBeNull();
    });
    expect(screen.queryByTestId("lodge-setup-inactive-notice")).toBeNull();
  });

  it("gates activation for a lodge:view admin, and leaves the reason to the banner", async () => {
    /*
      Activation is the one control in this flow that makes a lodge BOOKABLE, so
      it must be gated exactly like its five siblings: disabled, silent about
      itself, and explained once by the section banner the page hoists above its
      early returns. `describeReason={false}` is what puts the explanation there
      rather than on the button, and `view-only-banner-contract.test.ts` refuses
      that opt-out in a file with no banner — this pins the other half, that the
      button really does go dead and really does write nothing.
    */
    const calls = await renderFinishStep({ active: false });
    const before = calls.length;

    session.lodgeLevel = "view";
    rerenderPage();

    const activate = await screen.findByTestId("lodge-setup-activate");
    expect(activate).toBeDisabled();

    // No per-button reason: no title, no aria-describedby, no sr-only line.
    expect(activate).not.toHaveAttribute("title");
    expect(activate).not.toHaveAttribute("aria-describedby");
    expect(
      screen.queryByText(ADMIN_VIEW_ONLY_ACTION_REASON),
    ).toBeNull();
    // The banner is the one place it IS said.
    expect(
      screen.getByText(/cannot change anything/i, { selector: "*" }),
    ).toBeTruthy();

    fireEvent.click(activate);
    await waitFor(() => {
      expect(calls.slice(before)).toEqual([]);
    });
    // Still closed, and still offering to be opened by someone who may.
    expect(screen.getByTestId("lodge-setup-inactive-notice")).toBeTruthy();
  });

  it("offers nothing to activate when the lodge is already open", async () => {
    await renderFinishStep({ active: true });
    expect(screen.queryByTestId("lodge-setup-inactive-notice")).toBeNull();
    expect(screen.queryByTestId("lodge-setup-activate")).toBeNull();
    expect(screen.getByText("All set")).toBeTruthy();
  });
});
