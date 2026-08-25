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
          lodge: "edit",
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

async function renderFinishStep(lodge: { active: boolean }) {
  const calls: FetchCall[] = [];
  stubFetch(lodge, calls);
  const LodgeSetupWizardPage = (
    await import("@/app/(admin)/admin/lodges/[id]/setup/page")
  ).default;
  render(<LodgeSetupWizardPage />);
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

  it("offers nothing to activate when the lodge is already open", async () => {
    await renderFinishStep({ active: true });
    expect(screen.queryByTestId("lodge-setup-inactive-notice")).toBeNull();
    expect(screen.queryByTestId("lodge-setup-activate")).toBeNull();
    expect(screen.getByText("All set")).toBeTruthy();
  });
});
