// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The wizard's inline panes (epic #213, children C12 and C13; owner decision
 * D16).
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
 * C13 (#239) adds three more, in the blocks at the foot of the file, because
 * the modules pane is the one that edits WHICH STEPS EXIST rather than facts a
 * check reads: the rail redrawing beside the toggles (D4/D5), what happens when
 * an operator removes the step they are standing on, and the first two registry
 * entries that share one component — the case C12's `key={stepId}` was written
 * for and could not exercise.
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

/*
  C17 (#248): `DefaultCancellationPolicySection`'s scope switch is its own
  contract, pinned in `cancellation-scope-switch.test.tsx` and its siblings —
  not what this file is about. Mocked to a fixed club-wide state, the same
  shape `cancellation-scope-switch.test.tsx` uses for its own non-scope
  assertions, so the pane composition tests below never touch
  `useLodgeOptions` or `/api/admin/lodges` at all.
*/
vi.mock("@/components/admin/booking-policies/policy-scope-select", () => ({
  usePolicyScopeOptions: () => ({
    state: { kind: "club-wide" as const },
    lodges: [],
    reload: vi.fn(),
  }),
  isPolicyScopeReady: () => true,
  PolicyScopeSelect: () => null,
}));

import { toast } from "sonner";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";
import {
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import type { SetupReadiness } from "@/lib/setup-readiness";
import {
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  type ModuleSettingsValues,
} from "@/config/modules";
import {
  CORE_STEP_OWNER,
  SETUP_STEP_IDS,
  SETUP_STEP_REGISTRY,
  getApplicableSetupStepIds,
  type SetupStepId,
} from "@/lib/setup-step-registry";
import { canViewSetupStepPane } from "@/lib/setup-wizard-view";
import type { SetupWizardTraversal } from "@/lib/setup-wizard-traversal";
import { SetupWizardClient } from "@/app/(admin)/admin/setup/wizard/setup-wizard-client";
import { SETUP_STEP_PANES } from "@/app/(admin)/admin/setup/wizard/setup-wizard-panes";

/**
 * `support: edit`, and `content: edit` too — a full editor of both areas, so
 * the pane mounts (F1, #238 fix round) AND its own Save is live. Most of this
 * file's tests want exactly that: they are pinning the PANE's behaviour, not
 * the area gate in front of it, and a matrix that left `content: none` (as
 * this used to, silently) would 403 the pane's own fetch on a real server —
 * F1 is precisely the wizard client failing to look before it mounts.
 */
const supportEditor = {
  ...emptyAdminPermissionMatrix(),
  support: "edit" as const,
  content: "edit" as const,
};

/**
 * `support: edit` (can change progress), `content: view` but not `edit` — the
 * one shape that should mount the pane with a live banner and a dead Save.
 */
const supportEditorContentViewer = {
  ...emptyAdminPermissionMatrix(),
  support: "edit" as const,
  content: "view" as const,
};

/**
 * The three shipped role bundles F1 names, resolved through the real bundle
 * table rather than hand-copied — each carries `support: view` and no
 * `content` entry at all (`content: none`), the shape that reached
 * `club-config` and 403'd on the pane's own fetch before this fix.
 */
const NO_CONTENT_BUNDLES = ["ADMIN_BOOKINGS", "ADMIN_MEMBERSHIP", "FINANCE_ADMIN"] as const;

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

const CANCELLATION_RULES = [
  {
    daysBeforeStay: 14,
    refundPercentage: 100,
    creditRefundPercentage: 100,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
  },
];

const GROUP_DISCOUNT = {
  minGroupSize: 5,
  summerOnly: true,
  enabled: false,
  applyToEdits: true,
  configured: true,
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
    // C17 (#248): club-wide only (the scope switch is mocked away above), so
    // the same shape answers both the mount GET and a Save's PUT.
    if (target === "/api/admin/booking-policies/cancellation") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rules: CANCELLATION_RULES,
          nonMemberHoldEnabled: true,
          nonMemberHoldDays: 7,
          waitlistCrossLodgeOrder: "OWN_LODGE_FIRST",
        }),
      };
    }
    if (target === "/api/admin/booking-policies/group-discount") {
      return {
        ok: true,
        status: 200,
        json: async () => GROUP_DISCOUNT,
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

/**
 * Structurally typed rather than `ReturnType<typeof stubFetch>`: C13 adds a
 * second, stateful stub whose payload types differ, and both are read by this
 * helper. What it needs is the call list, not either stub's response shape.
 */
function callsTo(
  fetchMock: { mock: { calls: readonly (readonly unknown[])[] } },
  url: string,
) {
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
      case that proves it rather than asserting it: a Support editor with
      `content: view` but not `edit` can still record progress, and cannot
      change the club's name. Both controls are on screen at once, in opposite
      states. `content: view` is what mounts the pane at all post-F1 — this is
      the one shape that both clears the mount gate and leaves Save disabled.
    */
    mocks.canEdit.mockReturnValue(false);
    stubFetch([["club-config", "Club Configuration"]]);
    render(<SetupWizardClient permissionMatrix={supportEditorContentViewer} />);

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

describe("a viewer with no VIEW access to the pane's own area (#238 fix round F1)", () => {
  /*
    Before this fix, `SetupWizardStepPane` mounted `ClubIdentityPanel`
    unconditionally the moment a pane existed for the step, so a viewer whose
    matrix carried `content: none` still got the panel — and its own
    `GET /api/admin/club-identity` 403'd, landing on an error toast, a red
    paragraph and a Retry that can never succeed (the fetch always answers the
    same 403 for the same viewer), under a frame banner naming an unrelated
    permission (`support`). Each of these three is a real shipped bundle
    (`admin-permissions.ts` `ADMIN_ROLE_BUNDLES`) that reaches `club-config`
    with exactly that shape: `support: view` (enough to be admitted to
    `/admin/setup/wizard`, which gates on the `support` route prefix) and no
    `content` key at all.
  */
  it.each(NO_CONTENT_BUNDLES)(
    "mounts no pane, makes no pane fetch, and shows no error toast for %s",
    async (bundle) => {
      const matrix = getAdminPermissionMatrix({ accessRoles: [bundle] });
      expect(matrix.content).toBe("none");
      expect(matrix.support).toBe("view");

      const fetchMock = stubFetch([["club-config", "Club Configuration"]]);
      render(<SetupWizardClient permissionMatrix={matrix} />);

      // Wait for the journey read to resolve — the frame is what proves the
      // wizard finished loading and chose not to render a pane, rather than
      // racing the pane's own (absent) fetch.
      expect(
        (await screen.findByTestId("setup-wizard-step-frame")).getAttribute(
          "data-step-id",
        ),
      ).toBe("club-config");

      expect(screen.queryByTestId("setup-wizard-step-pane")).toBeNull();
      expect(callsTo(fetchMock, "/api/admin/club-identity")).toHaveLength(0);
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("mounts the pane, and its editable field, for a full administrator", async () => {
    // The positive control for the three above: `content: edit` (the ADMIN
    // bundle) clears the gate and the field is genuinely editable, not merely
    // present.
    const matrix = getAdminPermissionMatrix({ accessRoles: ["ADMIN"] });
    expect(matrix.content).toBe("edit");

    stubFetch([["club-config", "Club Configuration"]]);
    render(<SetupWizardClient permissionMatrix={matrix} />);

    const clubName = (await screen.findByLabelText(
      "Club name",
    )) as HTMLInputElement;
    expect(clubName.disabled).toBe(false);
  });

  it("pins the gate function itself, so a swapped comparison fails here first", () => {
    // The rendered tests above prove the wired-up behaviour; this pins the
    // production gate function directly, so a change to `canViewSetupStepPane`
    // (e.g. `!==` flipped to `===`, or `content` hardcoded instead of read off
    // `SETUP_STEP_PERMISSION_AREA`) fails a fast unit test rather than only a
    // slower render one.
    for (const bundle of NO_CONTENT_BUNDLES) {
      const matrix = getAdminPermissionMatrix({ accessRoles: [bundle] });
      expect(canViewSetupStepPane(matrix, "club-config")).toBe(false);
    }
    const admin = getAdminPermissionMatrix({ accessRoles: ["ADMIN"] });
    expect(canViewSetupStepPane(admin, "club-config")).toBe(true);
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

// ---------------------------------------------------------------------------
// C13 (#239) — the module toggles, and the rail that redraws beside them
// ---------------------------------------------------------------------------
/*
  Everything above pins a pane that edits facts a readiness check READS. This
  block pins the one that edits WHICH STEPS EXIST, which is a different thing
  and the reason D5 called it the most wizard-like moment in the design:
  `setup-step-registry.ts` derives applicability from the module flags, so a
  module save moves the rail's rows, the percentage's denominator and — for one
  step — the ground the operator is standing on.

  The fixtures below drive the REAL applicability function
  (`getApplicableSetupStepIds`) rather than a hand-written map of flags to step
  ids. A hand-written one would keep passing after somebody re-declared a
  module's `setupSteps`, which is exactly the change these tests exist to catch.
*/

const ALL_MODULES_OFF = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, false]),
) as ModuleSettingsValues;

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

/**
 * A traversal over exactly the steps these flags make applicable.
 *
 * `club-config` is confirmed in every fixture here so the percentage has a
 * numerator: one complete step over however many the flags leave applicable.
 * That is what makes a DENOMINATOR change visible — a journey with nothing
 * complete reads 0% at every length.
 */
function traversalFor(
  ids: SetupStepId[],
  currentId: SetupStepId,
): SetupWizardTraversal<SetupStepId> {
  const complete = ids.filter((id) => id === "club-config");
  return {
    steps: ids.map((id, index) => ({
      id,
      ownerModule: "core",
      order: (index + 1) * 10,
      state:
        id === "club-config"
          ? ("complete" as const)
          : id === currentId
            ? ("current" as const)
            : ("not-started" as const),
      isComplete: id === "club-config",
      isStale: false,
      isDeferred: false,
      isDefaulted: false,
      // Everything walkable, so a rail click resolves and the fallback under
      // test is a step DISAPPEARING rather than a step being locked.
      isReachable: true,
    })),
    applicableStepIds: ids,
    staleStepIds: [],
    outstandingStepIds: ids.filter((id) => id !== "club-config"),
    blockingStepIds: ids.filter((id) => id !== "club-config"),
    currentStepId: currentId,
    navigationFrontierStepId: currentId,
    allResolved: false,
    percentComplete: Math.round((complete.length / ids.length) * 100),
  };
}

/**
 * One stateful stub for the journey read AND the modules route, so a save
 * really does change what the next journey read reports — which is the whole
 * behaviour under test. A stub that answered a fixed payload would let a wizard
 * that never re-read at all pass every assertion below.
 */
function stubModulesFetch(
  initial: Partial<ModuleSettingsValues>,
  landOn: SetupStepId,
) {
  let settings = { ...ALL_MODULES_OFF, ...initial } as ModuleSettingsValues;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === "/api/admin/modules") {
      if (init?.method === "PUT") {
        settings = (
          JSON.parse(String(init.body)) as { settings: ModuleSettingsValues }
        ).settings;
      }
      return {
        ok: true,
        status: 200,
        json: async () => modulesPayload(settings),
      };
    }
    const ids = getApplicableSetupStepIds(settings);
    // The real traversal resumes on the first outstanding step; when the step
    // we landed on has just been switched out of existence, that is what it
    // would answer, so the fixture answers it too rather than naming a step
    // its own `applicableStepIds` no longer contains.
    const current = ids.includes(landOn)
      ? landOn
      : (ids.find((id) => id !== "club-config") ?? ids[0]);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        isSiteVisible: false,
        readiness: readinessWith(ids.map((id) => [id, id] as [SetupStepId, string])),
        traversal: traversalFor(ids, current),
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

const XERO_LABEL = MODULE_DEFINITIONS.xeroIntegration.label;
const ADDRESS_LABEL = MODULE_DEFINITIONS.addressAutocomplete.label;

function moduleCheckbox(label: string) {
  return screen.getByRole("checkbox", { name: label }) as HTMLInputElement;
}

function saveModules() {
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
}

describe("feature-flags mounts the real module editor", () => {
  it("renders the section's own toggles, and saves through the modules route", async () => {
    const fetchMock = stubModulesFetch({}, "feature-flags");
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    const xero = await screen.findByRole("checkbox", { name: XERO_LABEL });
    expect(xero).not.toBeChecked();
    expect(
      screen.getByTestId("setup-wizard-step-pane").getAttribute("data-step-id"),
    ).toBe("feature-flags");

    // STAGED: ticking the box writes nothing.
    fireEvent.click(xero);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url) === "/api/admin/modules" &&
          (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toHaveLength(0);

    saveModules();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url) === "/api/admin/modules" &&
            (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toHaveLength(1),
    );
  });

  it("does not tick the step off — no setup-progress write, one extra journey read", async () => {
    const fetchMock = stubModulesFetch({}, "feature-flags");
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    await screen.findByRole("checkbox", { name: XERO_LABEL });
    expect(callsTo(fetchMock, "/api/admin/setup/wizard")).toHaveLength(1);

    fireEvent.click(moduleCheckbox(XERO_LABEL));
    saveModules();

    await waitFor(() =>
      expect(callsTo(fetchMock, "/api/admin/setup/wizard")).toHaveLength(2),
    );
    expect(callsTo(fetchMock, "/api/admin/setup/progress")).toHaveLength(0);
  });
});

describe("the rail redraws beside the toggles (D4/D5)", () => {
  it("gains the module's steps, and its denominator, when it is switched on", async () => {
    // `financeDashboard` starts ON, for two reasons: its own step must survive
    // untouched while a DIFFERENT module's flag moves, and its extra step makes
    // the journey 17 long, which is where one confirmed step rounds to 6% and
    // 19 rounds to 5%. At 16 -> 18 the true denominator change is invisible in
    // the rounded percentage, so the assertion below would have been vacuous.
    stubModulesFetch({ financeDashboard: true }, "feature-flags");
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    await screen.findByRole("checkbox", { name: XERO_LABEL });
    expect(screen.queryByTestId("setup-wizard-rail-row-xero-operational")).toBeNull();
    expect(screen.queryByTestId("setup-wizard-rail-row-xero-mappings")).toBeNull();
    const before = Number(
      screen.getByTestId("setup-wizard-percent").textContent?.replace("%", ""),
    );

    fireEvent.click(moduleCheckbox(XERO_LABEL));
    saveModules();

    // The two steps `xeroIntegration` declares, in the rail, without the
    // operator ever leaving the wizard.
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-rail-row-xero-operational")).toBeTruthy(),
    );
    expect(screen.getByTestId("setup-wizard-rail-row-xero-mappings")).toBeTruthy();

    // …and the percentage fell, because the same one confirmed step is now
    // divided by two more. This is the assertion that would still pass on a
    // rail rebuilt from a cached view, so it is deliberately about the NUMBER
    // and not only about the rows.
    const after = Number(
      screen.getByTestId("setup-wizard-percent").textContent?.replace("%", ""),
    );
    expect(after).toBeLessThan(before);

    expect(screen.getByTestId("setup-wizard-rail-row-finance-dashboard")).toBeTruthy();

    // The operator has not moved: `feature-flags` is core-owned and nothing
    // removed it.
    expect(
      screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
    ).toBe("feature-flags");
    expect(screen.queryByTestId("setup-wizard-moved-notice")).toBeNull();
  });

  it("loses them again when it is switched off", async () => {
    stubModulesFetch({ xeroIntegration: true, financeDashboard: true }, "feature-flags");
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    // The section's own fetch resolves independently of the journey read, so
    // wait for the CHECKBOX rather than for the rail row: the rail is painted
    // first and the pane can still be showing its spinner.
    await screen.findByRole("checkbox", { name: XERO_LABEL });
    expect(screen.getByTestId("setup-wizard-rail-row-xero-operational")).toBeTruthy();
    const before = Number(
      screen.getByTestId("setup-wizard-percent").textContent?.replace("%", ""),
    );

    fireEvent.click(moduleCheckbox(XERO_LABEL));
    saveModules();

    await waitFor(() =>
      expect(screen.queryByTestId("setup-wizard-rail-row-xero-operational")).toBeNull(),
    );
    expect(screen.queryByTestId("setup-wizard-rail-row-xero-mappings")).toBeNull();
    // The finance dashboard's step is untouched — one module's flag moves one
    // module's steps.
    expect(screen.getByTestId("setup-wizard-rail-row-finance-dashboard")).toBeTruthy();
    expect(
      Number(screen.getByTestId("setup-wizard-percent").textContent?.replace("%", "")),
    ).toBeGreaterThan(before);
    expect(
      screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
    ).toBe("feature-flags");
  });
});

describe("switching off the module that owns the step you are standing on", () => {
  /*
    The one asymmetric case, and the only self-removal either pane can produce.
    `address-autocomplete` is the ONLY step whose own module's checkbox sits on
    the section embedded beneath it, and every module-owned step orders at or
    after it — so "a module step BEFORE the current one disappears" is not a
    case that can arise from either of C13's two panes. The registry assertion
    at the foot of this block is what keeps that true.
  */
  it("moves the operator on, and says so, when they chose the step themselves", async () => {
    stubModulesFetch({ addressAutocomplete: true }, "feature-flags");
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    fireEvent.click(
      await screen.findByTestId("setup-wizard-rail-row-address-autocomplete"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-pane").getAttribute("data-step-id"),
      ).toBe("address-autocomplete"),
    );
    // The pane container mounts before the section's own fetch resolves, so
    // wait for a control rather than for the container.
    await screen.findByRole("checkbox", { name: ADDRESS_LABEL });
    expect(screen.queryByTestId("setup-wizard-moved-notice")).toBeNull();

    fireEvent.click(moduleCheckbox(ADDRESS_LABEL));
    saveModules();

    const notice = await screen.findByTestId("setup-wizard-moved-notice");
    expect(notice.textContent).toContain("no longer available");
    // F4 (#239 fix round): the section's own "Module settings saved." message
    // dies with the remount its own save causes (a new `stepId` key on
    // `SetupWizardStepPane`), so the notice that survives it must say the
    // write succeeded — otherwise the operator's screen goes straight from
    // "Save" to a sentence about navigation with no word the write landed.
    expect(notice.textContent).toContain("Your module settings were saved.");
    expect(screen.queryByTestId("setup-wizard-rail-row-address-autocomplete")).toBeNull();
    expect(
      screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
    ).not.toBe("address-autocomplete");
  });

  it("says so even when they never chose it — it was simply their resume point", async () => {
    /*
      Before C13 the shell only announced a move it could blame on an
      invalidated SELECTION, because nothing an operator did on this screen
      could delete the step under them. Riding `currentStepId` with no selection
      is the ordinary state of a fresh arrival, and it is now the state in which
      an operator can remove their own step and watch the frame become a
      different one with nothing connecting the two.
    */
    stubModulesFetch({ addressAutocomplete: true }, "address-autocomplete");
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    await screen.findByRole("checkbox", { name: ADDRESS_LABEL });
    expect(
      screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
    ).toBe("address-autocomplete");
    expect(screen.queryByTestId("setup-wizard-moved-notice")).toBeNull();

    fireEvent.click(moduleCheckbox(ADDRESS_LABEL));
    saveModules();

    const notice = await screen.findByTestId("setup-wizard-moved-notice");
    expect(notice.textContent).toContain("no longer available");
    // F4 (#239 fix round): this path — no explicit selection — goes through
    // the SAME `reportMoved()` as the explicit-selection test above, so it
    // must carry the same acknowledgement that the write behind the move
    // actually succeeded.
    expect(notice.textContent).toContain("Your module settings were saved.");
    expect(
      screen.getByTestId("setup-wizard-step-frame").getAttribute("data-step-id"),
    ).not.toBe("address-autocomplete");
  });

  it("stays quiet when the step is still there — an ordinary refetch is not a move", async () => {
    // The narrowing that stops the notice above from firing on every save: a
    // module going on or off while the operator stands on `feature-flags`
    // changes the rail, not their position.
    stubModulesFetch({}, "feature-flags");
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    await screen.findByRole("checkbox", { name: XERO_LABEL });
    fireEvent.click(moduleCheckbox(XERO_LABEL));
    saveModules();

    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-rail-row-xero-operational")).toBeTruthy(),
    );
    expect(screen.queryByTestId("setup-wizard-moved-notice")).toBeNull();
  });

  it("has no module-owned step ordered before address-autocomplete", () => {
    /*
      The structural half of the reasoning above, so it stops being true LOUDLY
      rather than quietly. The invariant this guards — stated identically in
      this block's own reasoning, in setup-wizard-panes.tsx's docstring,
      guides/setup.md and UX_FLOW_MAP — is that every module-owned step orders
      AT OR AFTER address-autocomplete specifically, not merely at or after
      the EARLIER of the two panes (feature-flags is the earlier one, so a
      Math.min over both pane steps would silently let a module step land in
      the 61-139 gap between them: past feature-flags, still ahead of
      address-autocomplete, and nobody would have noticed). Anchoring on
      address-autocomplete alone is what closes that gap: a later child
      declaring a module step earlier in the journey creates a case nobody has
      thought about — an operator watching a rail row vanish from BEHIND them
      — and this fails at that moment.
    */
    const orderOf = (id: SetupStepId) =>
      SETUP_STEP_REGISTRY.find((entry) => entry.id === id)!.order;
    const addressAutocompleteOrder = orderOf("address-autocomplete");

    const moduleOwned = SETUP_STEP_REGISTRY.filter(
      (entry) => entry.ownerModule !== CORE_STEP_OWNER,
    );
    expect(moduleOwned.length).toBeGreaterThan(0);
    for (const entry of moduleOwned) {
      expect(
        entry.order,
        `${entry.id} (module "${entry.ownerModule}", order ${entry.order}) must ` +
          `order >= address-autocomplete's ${addressAutocompleteOrder} — every ` +
          `module step must sit at or after the modules panes so no rail row ` +
          `can vanish from behind the operator`,
      ).toBeGreaterThanOrEqual(addressAutocompleteOrder);
    }
  });
});

describe("two steps sharing one pane", () => {
  it("registers the same component for both, rather than a second copy of the editor", () => {
    // The registration C12's `key={stepId}` was written for and could not be
    // exercised: until now no two entries named the same component.
    expect(SETUP_STEP_PANES["feature-flags"]).not.toBeNull();
    expect(SETUP_STEP_PANES["address-autocomplete"]).toBe(
      SETUP_STEP_PANES["feature-flags"],
    );
  });

  it("starts the section over when the operator walks between them, discarding the draft", async () => {
    /*
      THE HAZARD THE KEY EXISTS FOR. React reconciles two renders of the same
      component type at the same position as ONE element, so without
      `key={stepId}` the section would keep its state across a step change —
      and the state here is an unsaved checkbox draft. The operator would walk
      to another step, walk back, and find a module ticked that they believed
      they had navigated away from, with Save live.
    */
    stubModulesFetch({ addressAutocomplete: true }, "feature-flags");
    render(<SetupWizardClient permissionMatrix={supportEditor} />);

    await screen.findByRole("checkbox", { name: XERO_LABEL });
    fireEvent.click(moduleCheckbox(XERO_LABEL));
    expect(moduleCheckbox(XERO_LABEL)).toBeChecked();
    // Dirty, so Save is live: this is what must NOT survive the walk.
    expect(
      (screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByTestId("setup-wizard-rail-row-address-autocomplete"));

    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-pane").getAttribute("data-step-id"),
      ).toBe("address-autocomplete"),
    );
    // A fresh mount: the section fetched again, the draft is the saved state,
    // and Save is dead because nothing is dirty.
    await waitFor(() => expect(moduleCheckbox(XERO_LABEL)).not.toBeChecked());
    expect(
      (screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("the C12 area gate composes for the modules panes", () => {
  it("admits support:view — the same access that admits anybody to the wizard", () => {
    // Both steps are registered `support` in `SETUP_STEP_PERMISSION_AREA`, and
    // `support: view` is what gates admission to `/admin/setup/wizard` itself.
    // So the pane gate can never be the thing that hides these two from
    // somebody already standing on the step, which is the answer the wizard
    // wants and is worth pinning rather than assuming.
    const viewer = { ...emptyAdminPermissionMatrix(), support: "view" as const };
    expect(canViewSetupStepPane(viewer, "feature-flags")).toBe(true);
    expect(canViewSetupStepPane(viewer, "address-autocomplete")).toBe(true);

    const outsider = emptyAdminPermissionMatrix();
    expect(outsider.support).toBe("none");
    expect(canViewSetupStepPane(outsider, "feature-flags")).toBe(false);
    expect(canViewSetupStepPane(outsider, "address-autocomplete")).toBe(false);
  });

  it("mounts the section read-only for a support:view admin", async () => {
    // The section's OWN gate, unchanged by the embed: `useAdminAreaEditAccess`
    // says no, so every checkbox is disabled and Save is dead — under the
    // section's own banner, which is a different sentence from the frame's.
    mocks.canEdit.mockReturnValue(false);
    stubModulesFetch({}, "feature-flags");
    render(
      <SetupWizardClient
        permissionMatrix={{ ...emptyAdminPermissionMatrix(), support: "view" }}
      />,
    );

    const xero = await screen.findByRole("checkbox", { name: XERO_LABEL });
    expect(xero).toBeDisabled();
    expect(
      (screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen
        .getAllByTestId("admin-view-only-banner")
        .some((banner) =>
          banner.textContent?.includes(
            "can view the module settings but cannot change them",
          ),
        ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C17 (#248) — booking-policies embeds the two sections its own verdict reads
// ---------------------------------------------------------------------------
/*
  D16 deferred this step to backlog because `/admin/booking-policies` is six
  independent staged sections rather than one. C17 makes that decision — see
  `BookingPoliciesWizardPane`'s own docblock for which two of the six and why
  the other four stay behind the link — and this block pins the composition:
  BOTH sections' real fields render and save through their own APIs, each
  keeps its OWN banner (the sanctioned stacked-sections case named in
  `docs/ARCHITECTURE.md`, not #2168's collapsed member-detail shape), and a
  successful save from EITHER makes the wizard re-read without ticking the
  step off — the same C11 model club-config and feature-flags already pin.

  `GroupDiscountSection` reads `useClubIdentity()`, which nothing else in this
  file needs, so only this block's renders wrap in `ClubIdentityProvider`.
*/

const bookingsEditor = {
  ...emptyAdminPermissionMatrix(),
  support: "edit" as const,
  bookings: "edit" as const,
};

const bookingsViewerOnly = {
  ...emptyAdminPermissionMatrix(),
  support: "edit" as const,
  bookings: "view" as const,
};

function renderBookingPoliciesWizard(
  matrix: ReturnType<typeof emptyAdminPermissionMatrix>,
) {
  return render(
    <ClubIdentityProvider value={clubIdentity}>
      <SetupWizardClient permissionMatrix={matrix} />
    </ClubIdentityProvider>,
  );
}

describe("booking-policies mounts the cancellation and group-discount sections", () => {
  it("renders both sections' own fields, under one pane container", async () => {
    stubFetch([["booking-policies", "Booking Policies"]]);
    renderBookingPoliciesWizard(bookingsEditor);

    expect(
      (await screen.findByTestId("setup-wizard-step-pane")).getAttribute(
        "data-step-id",
      ),
    ).toBe("booking-policies");
    expect(
      await screen.findByLabelText("Members First booking policy"),
    ).toBeTruthy();
    expect(await screen.findByLabelText("Enabled")).toBeTruthy();
    expect(screen.getByText("Default Policy")).toBeTruthy();
    expect(screen.getByText("Group Discount")).toBeTruthy();
  });

  it("saves the cancellation section through its own API, and makes the wizard re-read without ticking the step off", async () => {
    const fetchMock = stubFetch([["booking-policies", "Booking Policies"]]);
    renderBookingPoliciesWizard(bookingsEditor);

    await screen.findByLabelText("Members First booking policy");
    expect(callsTo(fetchMock, "/api/admin/setup/wizard")).toHaveLength(1);

    // The cancellation section renders first, so its "Edit" is index 0.
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    // STAGED: toggling the checkbox writes nothing until Save.
    fireEvent.click(screen.getByLabelText("Members First booking policy"));
    expect(
      callsTo(fetchMock, "/api/admin/booking-policies/cancellation").filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save Default Policy" }));

    await waitFor(() =>
      expect(
        callsTo(fetchMock, "/api/admin/booking-policies/cancellation").filter(
          ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toHaveLength(1),
    );
    // C11's model, unchanged: the save does not tick the step off — only one
    // extra journey read, and no progress write.
    await waitFor(() =>
      expect(callsTo(fetchMock, "/api/admin/setup/wizard")).toHaveLength(2),
    );
    expect(callsTo(fetchMock, "/api/admin/setup/progress")).toHaveLength(0);
  });

  it("saves the group-discount section through its own API, and makes the wizard re-read without ticking the step off", async () => {
    const fetchMock = stubFetch([["booking-policies", "Booking Policies"]]);
    renderBookingPoliciesWizard(bookingsEditor);

    // Both sections loaded, so the group-discount "Edit" is reliably index 1.
    await screen.findByLabelText("Members First booking policy");
    await screen.findByLabelText("Enabled");
    expect(callsTo(fetchMock, "/api/admin/setup/wizard")).toHaveLength(1);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    fireEvent.click(screen.getByLabelText("Enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save Group Discount" }));

    await waitFor(() =>
      expect(
        callsTo(fetchMock, "/api/admin/booking-policies/group-discount").filter(
          ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(callsTo(fetchMock, "/api/admin/setup/wizard")).toHaveLength(2),
    );
    expect(callsTo(fetchMock, "/api/admin/setup/progress")).toHaveLength(0);
  });

  it("shows each section's OWN view-only banner, and a dead Edit on both, for a bookings:view admin", async () => {
    /*
      The sanctioned stacked-sections case: TWO banners on this one pane,
      naming the same "bookings" area twice — not #2168's collapsed shape,
      because nothing here vouches for either section (neither destructures
      `ancestorRendersViewOnlyBanner`, and the wrapper renders no banner of its
      own to vouch WITH).
    */
    mocks.canEdit.mockReturnValue(false);
    stubFetch([["booking-policies", "Booking Policies"]]);
    renderBookingPoliciesWizard(bookingsViewerOnly);

    await screen.findByLabelText("Members First booking policy");
    await screen.findByLabelText("Enabled");

    const banners = screen.getAllByTestId("admin-view-only-banner");
    expect(
      banners.some((banner) =>
        banner.textContent?.includes(
          "can view the cancellation policy but cannot change it",
        ),
      ),
    ).toBe(true);
    expect(
      banners.some((banner) =>
        banner.textContent?.includes(
          "can view the group discount policy but cannot change it",
        ),
      ),
    ).toBe(true);

    const editButtons = screen.getAllByRole("button", {
      name: "Edit",
    }) as HTMLButtonElement[];
    expect(editButtons).toHaveLength(2);
    for (const button of editButtons) {
      expect(button.disabled).toBe(true);
    }

    // The OTHER permission question on this screen: changing the step's
    // PROGRESS is gated on `support`, not `bookings`, and this admin holds
    // `support: edit`.
    const markDone = screen.getByRole("button", {
      name: /Mark this step done/,
    }) as HTMLButtonElement;
    expect(markDone.disabled).toBe(false);
  });

  it("keeps the pane OUTSIDE the step frame", async () => {
    stubFetch([["booking-policies", "Booking Policies"]]);
    renderBookingPoliciesWizard(bookingsEditor);

    const pane = await screen.findByTestId("setup-wizard-step-pane");
    const frame = screen.getByTestId("setup-wizard-step-frame");
    expect(pane.getAttribute("data-step-id")).toBe("booking-policies");
    expect(frame.contains(pane)).toBe(false);
  });

  it("composes the area gate on `bookings`, matching both sections' own gate", () => {
    const viewer = { ...emptyAdminPermissionMatrix(), bookings: "view" as const };
    expect(canViewSetupStepPane(viewer, "booking-policies")).toBe(true);

    const outsider = emptyAdminPermissionMatrix();
    expect(outsider.bookings).toBe("none");
    expect(canViewSetupStepPane(outsider, "booking-policies")).toBe(false);
  });

  it("registers a real pane, not the D16-backlog null", () => {
    expect(SETUP_STEP_PANES["booking-policies"]).not.toBeNull();
  });
});
