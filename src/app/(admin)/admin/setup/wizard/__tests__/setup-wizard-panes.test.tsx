// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The wizard's inline panes (epic #213, child C12; owner decision D16).
 *
 * Four things are pinned here, and only the first is ordinary UI behaviour.
 *
 * 1. **The real editor is mounted, and it is the section's own.** `club-config`
 *    shows `ClubIdentityPanel`'s fields and saves through
 *    `PUT /api/admin/club-identity` — not through a second editor grown inside
 *    the wizard, which is exactly what D8's parity rule forbids. Staged: typing
 *    persists nothing.
 *
 * 2. **The pane is a SIBLING of the step frame, never inside it.** Asserted
 *    against the DOM rather than trusted to a comment, because the failure it
 *    prevents is invisible to a reader who has not read
 *    `view-only-banner-contract.test.ts` — a banner-bearing pane inside the
 *    banner-bearing frame shows a view-only admin the same class of sentence
 *    twice in one card, in two announced live regions.
 *
 * 3. **The registry is exhaustive at RUNTIME too.** The `Record<SetupStepId, …>`
 *    already fails the typecheck when a step is added, which is the real guard;
 *    this is the version that survives a `Partial`, an `as`, or an index
 *    signature slipped in by a later refactor to make an error go away.
 *
 * 4. **Saving a pane does not tick the step off** (C11's model, #237). The
 *    green badge means a person confirmed, and a form submission is not that
 *    statement. What it DOES do is make the wizard re-read, because the facts
 *    the readiness check reports on have just changed under it.
 *
 * The permission gate is driven through `use-admin-area-edit-access`, the same
 * handle `club-identity-panel.test.tsx` uses, rather than by assembling a
 * session whose access roles happen to resolve to `content: view` — the mapping
 * from roles to areas is that module's contract and is pinned in its own tests.
 */

const mocks = vi.hoisted(() => ({
  canEdit: vi.fn<() => boolean | undefined>(() => true),
  session: {
    data: { user: { accessRoles: ["ADMIN"] } } as unknown,
    status: "authenticated" as "authenticated" | "loading" | "unauthenticated",
  },
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: mocks.session.data, status: mocks.session.status }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import type { SetupReadiness } from "@/lib/setup-readiness";
import { SETUP_STEP_IDS, type SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardTraversal } from "@/lib/setup-wizard-traversal";
import { SetupWizardClient } from "@/app/(admin)/admin/setup/wizard/setup-wizard-client";
import { SETUP_STEP_PANES } from "@/app/(admin)/admin/setup/wizard/setup-wizard-panes";

const supportEditor = {
  ...emptyAdminPermissionMatrix(),
  support: "edit" as const,
};

const CLUB_IDENTITY = {
  name: "Alpine Sports Club",
  shortName: "",
  hutLeaderLabel: "",
  facebookUrl: "",
};

const CLUB_TIME_ZONE = {
  timeZone: "Pacific/Auckland",
  source: "persisted" as const,
  updatedAt: null,
  updatedByName: null,
  unusableStoredValue: null,
};

function readinessWith(ids: [SetupStepId, string][]): SetupReadiness {
  return {
    status: "not_started",
    summary: {
      total: ids.length,
      complete: 0,
      warning: 0,
      blocked: 0,
      skipped: 0,
    },
    categories: [
      {
        id: "foundation",
        title: "Foundation",
        description: "Club identity and first-install readiness.",
        status: "not_started",
        checks: ids.map(([id, title]) => ({
          id,
          title,
          description: `${title} description`,
          status: "not_started" as const,
          required: true,
          message: `${title} message`,
          details: [],
          href: "/admin/health",
          progress: "open" as const,
        })),
      },
    ],
    generatedAt: "2026-07-01T00:00:00.000Z",
  } as SetupReadiness;
}

function traversalWith(ids: SetupStepId[]): SetupWizardTraversal<SetupStepId> {
  return {
    steps: ids.map((id, index) => ({
      id,
      ownerModule: "core",
      order: (index + 1) * 10,
      state: index === 0 ? "current" : "not-started",
      isComplete: false,
      isStale: false,
      isDeferred: false,
      isDefaulted: false,
      isReachable: index === 0,
    })),
    applicableStepIds: ids,
    staleStepIds: [],
    outstandingStepIds: ids,
    blockingStepIds: ids,
    currentStepId: ids[0],
    navigationFrontierStepId: ids[0],
    allResolved: false,
    percentComplete: 0,
  };
}

/**
 * One fetch stub for the wizard read and both panes' own endpoints, so a pane's
 * request can never be mistaken for the journey's.
 */
function stubFetch(ids: [SetupStepId, string][]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === "/api/admin/club-identity") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ settings: CLUB_IDENTITY }),
      };
    }
    if (target === "/api/admin/club-time-zone") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state:
            init?.method === "PUT"
              ? { ...CLUB_TIME_ZONE, timeZone: "Pacific/Chatham" }
              : CLUB_TIME_ZONE,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        isSiteVisible: false,
        readiness: readinessWith(ids),
        traversal: traversalWith(ids.map(([id]) => id)),
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof stubFetch>, url: string) {
  return fetchMock.mock.calls.filter(([called]) => String(called) === url);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.canEdit.mockReturnValue(true);
  mocks.session.data = { user: { accessRoles: ["ADMIN"] } };
  mocks.session.status = "authenticated";
});

describe("the pane registry", () => {
  it("answers for every step in the registry, and only for those", () => {
    /*
      The `Record<SetupStepId, …>` is the real guard and it runs at COMPILE
      time — this is the runtime shadow of it, which is what survives somebody
      widening the type to make an error go away. Both directions: a step with
      no answer is the gap the type prevents, and a key that is not a step is a
      table still answering for something that has been deleted.
    */
    const answered = Object.keys(SETUP_STEP_PANES).sort();
    expect(answered).toEqual([...SETUP_STEP_IDS].sort());
  });

  it("makes every no-pane step an explicit null rather than a missing key", () => {
    // `undefined` and `null` both render nothing, so the distinction is
    // invisible on screen and only this can hold it: a null was decided, a
    // missing key was forgotten.
    for (const id of SETUP_STEP_IDS) {
      const entry = SETUP_STEP_PANES[id];
      expect(
        entry === null || typeof entry === "function",
        `${id} must be a component or an explicit null`,
      ).toBe(true);
    }
  });
});

describe("club-config renders the real club identity editor inline", () => {
  it("mounts the section's own fields, and saves through the section's own API", async () => {
    const fetchMock = stubFetch([["club-config", "Club Configuration"]]);
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    const clubName = (await screen.findByLabelText(
      "Club name",
    )) as HTMLInputElement;
    expect(clubName.value).toBe("Alpine Sports Club");

    // STAGED: typing writes nothing.
    fireEvent.change(clubName, { target: { value: "Ruapehu Alpine Club" } });
    expect(
      callsTo(fetchMock, "/api/admin/club-identity").filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /Save club identity/ }));

    await waitFor(() =>
      expect(
        callsTo(fetchMock, "/api/admin/club-identity").filter(
          ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toHaveLength(1),
    );
    const put = callsTo(fetchMock, "/api/admin/club-identity").find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toMatchObject({
      name: "Ruapehu Alpine Club",
    });
  });

  it("does not write setup progress when the pane saves, but does make the wizard re-read", async () => {
    /*
      C11's model, unchanged: "Mark this step done" is the one gesture that says
      a person agreed, and a form submission is not that statement. The re-read
      is the other half — the step's readiness detail, its badge and the rail's
      percentage were all computed from the value that was just replaced, and
      neither of the shell's other refetch triggers fires for a save that never
      left the tab.
    */
    const fetchMock = stubFetch([["club-config", "Club Configuration"]]);
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    await screen.findByLabelText("Club name");
    expect(callsTo(fetchMock, "/api/admin/setup/wizard")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Save club identity/ }));

    await waitFor(() =>
      expect(callsTo(fetchMock, "/api/admin/setup/wizard")).toHaveLength(2),
    );
    expect(callsTo(fetchMock, "/api/admin/setup/progress")).toHaveLength(0);
  });

  it("shows the pane's own view-only banner and a dead save, leaving the frame's progress controls alone", async () => {
    /*
      The two permissions on this screen have different answers, and this is the
      case that proves it rather than asserting it: a Support editor with no
      `content` edit can still record progress, and cannot change the club's
      name. Both controls are on screen at once, in opposite states.
    */
    mocks.canEdit.mockReturnValue(false);
    stubFetch([["club-config", "Club Configuration"]]);
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    const save = (await screen.findByRole("button", {
      name: /Save club identity/,
    })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const banners = screen.getAllByTestId("admin-view-only-banner");
    expect(
      banners.some((banner) =>
        banner.textContent?.includes("Content edit access is required"),
      ),
    ).toBe(true);

    const markDone = screen.getByRole("button", {
      name: /Mark this step done/,
    }) as HTMLButtonElement;
    expect(markDone.disabled).toBe(false);
  });

  it("keeps the pane OUTSIDE the step frame", async () => {
    /*
      The nesting rule in `view-only-banner-contract.test.ts` is a static scan
      over imports, so it can prove the frame does not IMPORT a banner-bearing
      pane — it cannot see where the rendered pane ends up in the tree. This
      does, and it is the assertion that would fail first if somebody moved the
      render site inside the frame while keeping the registry where it is.
    */
    stubFetch([["club-config", "Club Configuration"]]);
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    const pane = await screen.findByTestId("setup-wizard-step-pane");
    const frame = screen.getByTestId("setup-wizard-step-frame");
    expect(pane.getAttribute("data-step-id")).toBe("club-config");
    expect(frame.contains(pane)).toBe(false);
  });
});

describe("club-time-zone replicates its page shell's Full-Admin swap", () => {
  it("mounts the panel for a full administrator", async () => {
    stubFetch([["club-time-zone", "Club Time Zone"]]);
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    expect(
      (await screen.findByTestId("current-club-time-zone")).textContent,
    ).toBe("Pacific/Auckland");
  });

  it("swaps in the full-administrators-only panel for anybody else", async () => {
    // The panel renders NO view-only banner on purpose — it has one permission
    // level, not two — so without this swap a Support Officer would be shown a
    // "Change time zone" button whose PUT answers 403.
    mocks.session.data = { user: { accessRoles: ["SUPPORT"] } };
    stubFetch([["club-time-zone", "Club Time Zone"]]);
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    expect(
      await screen.findByText(
        /The club time zone is available to full administrators only/,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("current-club-time-zone")).toBeNull();
  });

  it("shows the panel while the session is still resolving, rather than flashing the refusal", async () => {
    // `session &&` in the page shell, replicated: with nothing resolved there
    // are no access roles to read, and answering "not a full admin" from an
    // empty array would flash the refusal at the very people allowed in.
    mocks.session.data = null;
    mocks.session.status = "loading";
    stubFetch([["club-time-zone", "Club Time Zone"]]);
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    expect(await screen.findByTestId("current-club-time-zone")).toBeTruthy();
    expect(
      screen.queryByText(/available to full administrators only/),
    ).toBeNull();
  });
});

describe("a step with no pane", () => {
  it("renders exactly as it did before, with no pane container at all", async () => {
    // `runtime-env` is a registered null: its facts come from the running
    // process and no admin screen can edit them.
    expect(SETUP_STEP_PANES["runtime-env"]).toBeNull();
    stubFetch([["runtime-env", "Runtime Environment"]]);
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    expect(
      (await screen.findByTestId("setup-wizard-step-frame")).getAttribute(
        "data-step-id",
      ),
    ).toBe("runtime-env");
    expect(screen.queryByTestId("setup-wizard-step-pane")).toBeNull();
  });
});
