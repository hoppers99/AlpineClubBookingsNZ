// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The `seed-admin` pane (epic #213, child C20; owner decision D18, UAT R2-6).
 *
 * Four things are pinned here, and the second is the one this file exists for.
 *
 * 1. **The create path is the real membership API.** `POST /api/admin/members`,
 *    the same route and the same guard (`membership: edit`) the step's own
 *    permission area names — not a second create endpoint grown inside the
 *    wizard.
 *
 * 2. **The payload moves the readiness check's count.** That check counts the
 *    LEGACY `role` column while the modern authorisation path is `accessRoles`
 *    tokens, so a create can succeed, look right, and leave the step amber for
 *    ever. The pin is not "the body contains a magic string": it runs the
 *    body's own tokens through `legacyRoleFromAccessRoles` — the real function
 *    `createAdminMember` derives that column with — and requires the answer to
 *    be the `"ADMIN"` the count filters on. The other half of the chain (that
 *    the count really does filter on that value) is pinned against the real
 *    snapshot builder in `src/lib/__tests__/setup-readiness-admin-count.test.ts`.
 *
 * 3. **The invite is dispatched by the create itself.** Verified in
 *    `createAdminMember`, which issues the action token, writes the
 *    `PasswordResetToken` row and sends the email inline on `sendInvite: true`.
 *    So the pane must NOT follow up with
 *    `POST /api/admin/members/send-setup-invite` — a second call would mint a
 *    second token and send a second email. Asserted as an absence, because
 *    that is the shape the defect would take.
 *
 * 4. **Creating is not confirming** (C11's model, #237). The pane announces
 *    that a fact a readiness check reads has changed, and writes no progress.
 *
 * The permission gate is driven through `use-admin-area-edit-access`, the same
 * handle `setup-wizard-panes.test.tsx` and `club-identity-panel.test.tsx` use.
 * The FULL ADMIN gate is deliberately NOT mocked — it reads the session through
 * the real `isFullAdmin`, because that gate exists to predict a real 403 and a
 * hand-stubbed answer would only be testing itself.
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
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import { legacyRoleFromAccessRoles } from "@/lib/access-roles";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import { SETUP_READINESS_INPUT_CHANGED_EVENT } from "@/lib/setup-readiness-events";
import { canViewSetupStepPane } from "@/lib/setup-wizard-step-tables";
import { SETUP_STEP_PANES } from "@/app/(admin)/admin/setup/wizard/setup-wizard-panes";
import { SetupWizardFirstAdminPane } from "@/app/(admin)/admin/setup/wizard/setup-wizard-first-admin-pane";

/** A 201 with no `warning`: created, and the invite went out. */
function stubCreate(
  response: { ok?: boolean; status?: number; body?: unknown } = {},
) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: response.ok ?? true,
    status: response.status ?? 201,
    json: async () => response.body ?? { id: "m1", email: "kaia@example.test" },
  }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function fillTheForm() {
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: " Kaia@Example.test " },
  });
  fireEvent.change(screen.getByLabelText("First name"), {
    target: { value: "Kaia" },
  });
  fireEvent.change(screen.getByLabelText("Last name"), {
    target: { value: "Rewi" },
  });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /Create administrator/ }));
}

function bodyOf(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  const call = fetchMock.mock.calls.find(
    ([url]) => String(url) === "/api/admin/members",
  );
  return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.canEdit.mockReturnValue(true);
  mocks.session.data = { user: { accessRoles: ["ADMIN"] } };
  mocks.session.status = "authenticated";
});

describe("creating an administrator from the wizard", () => {
  it("posts the typed details to the membership API, and nothing before Create", async () => {
    const fetchMock = stubCreate();
    render(<SetupWizardFirstAdminPane />);

    fillTheForm();
    // STAGED: typing writes nothing.
    expect(fetchMock).not.toHaveBeenCalled();

    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/admin/members");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(bodyOf(fetchMock)).toMatchObject({
      email: "Kaia@Example.test",
      firstName: "Kaia",
      lastName: "Rewi",
    });
  });

  it("clears the form and announces the change, so the step's count re-reads", async () => {
    const fetchMock = stubCreate();
    const heard = vi.fn();
    window.addEventListener(SETUP_READINESS_INPUT_CHANGED_EVENT, heard);
    render(<SetupWizardFirstAdminPane />);

    fillTheForm();
    submit();

    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalled();
    expect(
      (screen.getByLabelText("Email address") as HTMLInputElement).value,
    ).toBe("");
    window.removeEventListener(SETUP_READINESS_INPUT_CHANGED_EVENT, heard);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not write setup progress — creating is not confirming", async () => {
    /*
      C11's model, unchanged since #237: "Mark this step done" is the one
      gesture that says a PERSON agreed, and a form submission is not that
      statement. The announcement above is the other half — it changes what the
      check READS, and the shell re-reads the journey (pinned end-to-end for the
      C12 panes in `setup-wizard-panes.test.tsx`).
    */
    const fetchMock = stubCreate();
    render(<SetupWizardFirstAdminPane />);

    fillTheForm();
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(
      fetchMock.mock.calls.map(([url]) => String(url)),
    ).not.toContain("/api/admin/setup/progress");
  });

  it("reports the API's own refusal rather than a generic failure", async () => {
    // The shape a scoped admin gets from `createAdminMember`'s Full-Admin gate,
    // and the shape a duplicate login email gets from its 409. Both carry a
    // sentence the operator can act on; swallowing it for "Could not create the
    // administrator." would hide which of the two happened.
    const fetchMock = stubCreate({
      ok: false,
      status: 409,
      body: { error: "That login email is already taken" },
    });
    render(<SetupWizardFirstAdminPane />);

    fillTheForm();
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(toast.error).toHaveBeenCalledWith(
      "That login email is already taken",
    );
    expect(toast.success).not.toHaveBeenCalled();
    // The typed details survive a refusal — retyping them is not the fix for a
    // taken email address.
    expect(
      (screen.getByLabelText("First name") as HTMLInputElement).value,
    ).toBe("Kaia");
  });
});

describe("THE COUNT THE STEP ACTUALLY READS", () => {
  /*
    `setup-readiness-db.ts` counts `member.role === "ADMIN"`, and the modern
    authorisation path is `accessRoles` tokens. A create that grants a SCOPED
    bundle leaves `role` at `"USER"` — the operator makes a working Membership
    Officer and the step stays amber with no error anywhere to explain it.

    `createAdminMember` derives the legacy column from the tokens
    (`legacyRole = data.accessRoles !== undefined ? legacyRoleFromAccessRoles(accessRoles) : data.role`),
    so the pane's job is to send a token set that derives to `"ADMIN"`. That is
    what this asserts — through the real derivation, not against a literal — so
    it fails both if the pane stops sending the token AND if the derivation ever
    stops mapping it that way.

    MUTATION-VERIFIED: deleting `accessRoles: ["ADMIN"]` from the pane's body
    fails this test (`Cannot read properties of undefined`, then `"USER"` once
    the read is guarded) while every other test in this file stays green — which
    is exactly the defect's real signature: a create that succeeds, a green
    toast, and a step that never turns.
  */
  it("sends a token set that derives the ADMIN role the count filters on", async () => {
    const fetchMock = stubCreate();
    render(<SetupWizardFirstAdminPane />);

    fillTheForm();
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = bodyOf(fetchMock);
    expect(Array.isArray(body.accessRoles)).toBe(true);
    expect(legacyRoleFromAccessRoles(body.accessRoles as string[])).toBe(
      "ADMIN",
    );
  });

  it("sends canLogin explicitly, because a cleared token set derives USER", async () => {
    /*
      Not belt-and-braces. `normalizeAssignableAccessRoleTokens` returns `[]`
      whenever `canLogin` is false, and the service's default for canLogin is
      derived from the age tier — so a payload that leaves it out is one
      unrelated default away from granting no access role at all, and
      `legacyRoleFromAccessRoles([])` is `"USER"`. The count would not move, and
      `sendInvite` would 422 on top.
    */
    const fetchMock = stubCreate();
    render(<SetupWizardFirstAdminPane />);

    fillTheForm();
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(bodyOf(fetchMock).canLogin).toBe(true);
    expect(legacyRoleFromAccessRoles([])).toBe("USER");
  });
});

describe("the setup invite", () => {
  it("is requested on the create itself, with no second send call", async () => {
    /*
      Dossier unknown #1, resolved by reading `createAdminMember`: `sendInvite`
      is handled inline after the transaction — one action token, one
      `PasswordResetToken` row, one `sendMemberSetupInviteEmail`. The separate
      `POST /api/admin/members/send-setup-invite` route exists for RE-sending to
      an existing member and must not be chained here.
    */
    const fetchMock = stubCreate();
    render(<SetupWizardFirstAdminPane />);

    fillTheForm();
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(bodyOf(fetchMock).sendInvite).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      "/api/admin/members/send-setup-invite",
    );
  });

  it("can be declined, and then says so", async () => {
    const fetchMock = stubCreate();
    render(<SetupWizardFirstAdminPane />);

    fillTheForm();
    fireEvent.click(screen.getByLabelText(/Send an account setup invite/));
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(bodyOf(fetchMock).sendInvite).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("Administrator created.");
  });

  it("surfaces a failed send as a warning, not as a failed create", async () => {
    /*
      `createAdminMember` catches the email failure and returns a 201 carrying a
      `warning`: the member EXISTS and the step's count HAS moved, so reporting
      this as an error would send the operator back to create a duplicate. It
      still has to be said out loud — nobody is going to arrive in that inbox.
    */
    const fetchMock = stubCreate({
      body: {
        id: "m1",
        warning: "Member created but invite email failed to send: no SES",
      },
    });
    const heard = vi.fn();
    window.addEventListener(SETUP_READINESS_INPUT_CHANGED_EVENT, heard);
    render(<SetupWizardFirstAdminPane />);

    fillTheForm();
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(toast.warning).toHaveBeenCalledWith(
      "Member created but invite email failed to send: no SES",
    );
    // The success copy must not claim the invite went out beside a warning
    // saying it did not (#251 review).
    expect(toast.success).toHaveBeenCalledWith("Administrator created.");
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    window.removeEventListener(SETUP_READINESS_INPUT_CHANGED_EVENT, heard);
  });
});

describe("who is offered the form", () => {
  it("is mounted for the step's own area, which is membership", () => {
    // The gate the wizard applies before the pane mounts at all (#238 F1). It
    // must agree with `POST /api/admin/members`'s `membership: edit` guard,
    // which is why the step's area is `membership` and not `support`.
    expect(SETUP_STEP_PANES["seed-admin"]).toBe(SetupWizardFirstAdminPane);
    const none = emptyAdminPermissionMatrix();
    expect(canViewSetupStepPane(none, "seed-admin")).toBe(false);
    expect(
      canViewSetupStepPane({ ...none, membership: "view" }, "seed-admin"),
    ).toBe(true);
  });

  it("shows a membership viewer the banner and a dead Create", async () => {
    mocks.canEdit.mockReturnValue(false);
    const fetchMock = stubCreate();
    render(<SetupWizardFirstAdminPane />);

    const create = screen.getByRole("button", {
      name: /Create administrator/,
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(
      (screen.getByLabelText("Email address") as HTMLInputElement).disabled,
    ).toBe(true);

    const banner = screen.getByTestId("admin-view-only-banner");
    expect(banner.textContent).toMatch(/Membership edit access is required/);

    fireEvent.click(create);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a scoped admin instead of offering a create the API will 403", () => {
    /*
      `SETUP_STEP_PERMISSION_AREA["seed-admin"]` is `membership`, so a
      Membership Officer reaches this pane — but granting a privileged access
      role additionally needs Full Admin (#1012), enforced in `createAdminMember`
      before anything is written. Offering the form to them would be an
      affordance whose only outcome is a 403. Read through the REAL
      `isFullAdmin`, off the session, so this cannot pass against a stub.
    */
    mocks.session.data = { user: { accessRoles: ["ADMIN_MEMBERSHIP"] } };
    render(<SetupWizardFirstAdminPane />);

    expect(
      screen.queryByRole("button", { name: /Create administrator/ }),
    ).toBeNull();
    expect(screen.getByText(/full administrators only may do/i)).toBeTruthy();
  });

  it("does not flash the refusal while the session is still resolving", () => {
    // The window `ClubTimeZoneWizardPane` guards the same way: with no session
    // yet there are no access roles to read, and answering "not a full admin"
    // from an empty array would show the refusal to the very administrators who
    // are allowed in. The server is the real gate either way.
    mocks.session.data = null;
    mocks.session.status = "loading";
    render(<SetupWizardFirstAdminPane />);

    expect(
      screen.getByRole("button", { name: /Create administrator/ }),
    ).toBeTruthy();
  });
});
