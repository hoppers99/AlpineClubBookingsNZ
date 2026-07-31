// @vitest-environment jsdom

/**
 * #2282 — "Add Dependent" as the admin actually meets it.
 *
 * Two behaviours are pinned here, because both were dead ends before:
 *
 *  1. AGE NO LONGER HIDES THE CONTROL. The card used to render the button only
 *     for an ADULT and to explain the absence with "Only adult members can
 *     manage dependents" — copy for a rule the code no longer enforces, on a
 *     member who can now genuinely be a parent.
 *  2. AN INACTIVE OR ARCHIVED MEMBER SEES THE CONTROL DISABLED WITH THE REASON,
 *     on BOTH the create and the link path. Those are two endpoints with two
 *     messages, so gating one leaves the identical dead end on the other; the
 *     dialog therefore states the block itself and disables its submit in
 *     whichever tab is showing.
 *
 * Mutation probes: drop `disabled={Boolean(blockReason)}` from either the card
 * or the dialog and the matching test fails; drop the dialog's `blockReason`
 * from the submit's `disabled` and both tab tests fail; re-add the age condition
 * around the card's button and "offers Add Dependent on a YOUTH member" fails.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// The dialog reads club-configurable optional fields over the network; neither
// switch is what this file is about.
vi.mock("@/lib/use-member-fields-settings", () => ({
  useMemberFieldsSettings: () => ({ showTitle: false, showGender: false }),
}));

// The header renders a role-name picker that fetches its options; the fallback
// list it serves until then is fine for these assertions.
vi.mock("@/hooks/use-access-role-options", () => ({
  useAccessRoleOptions: () => [],
}));

import { MemberDependentsCard } from "../member-dependents-card";
import { MemberDependentDialog } from "../member-dependent-dialog";
import { MemberDetailHeader } from "../member-detail-header";
import {
  DEPENDENT_PARENT_BLOCK_EXPLANATIONS,
  DEPENDENT_PARENT_CREATE_ERRORS,
  DEPENDENT_PARENT_LINK_ERRORS,
} from "@/lib/dependent-link-eligibility";
import type { MemberDetail } from "../../_types";

function buildMember(overrides: Partial<MemberDetail> = {}): MemberDetail {
  return {
    id: "member-1",
    firstName: "Tui",
    lastName: "Rangi",
    email: "tui@example.org",
    ageTier: "ADULT",
    active: true,
    archivedAt: null,
    canLogin: true,
    dependents: [],
    parentLinks: [],
    familyGroups: [],
    inheritEmailFromId: null,
    inheritEmailFrom: null,
    dependentEmailSource: {
      id: "member-1",
      firstName: "Tui",
      lastName: "Rangi",
      email: "tui@example.org",
    },
    ...overrides,
  } as unknown as MemberDetail;
}

function renderCard(member: MemberDetail, onOpen = vi.fn()) {
  render(
    <MemberDependentsCard
      member={member}
      currentMemberPath="/admin/members/member-1"
      unlinkingDependentId={null}
      onOpenDependentDialog={onOpen}
      onUnlinkDependent={vi.fn()}
      canEdit
    />,
  );
  return onOpen;
}

function renderDialog(
  member: MemberDetail,
  mode: "create" | "link",
  overrides: Record<string, unknown> = {},
) {
  const onSubmitCreate = vi.fn();
  const onSubmitLink = vi.fn();
  render(
    <MemberDependentDialog
      open
      onOpenChange={vi.fn()}
      member={member}
      mode={mode}
      onChangeMode={vi.fn()}
      error=""
      saving={false}
      createForm={
        {
          title: "",
          gender: "",
          firstName: "",
          lastName: "",
          email: "",
          dateOfBirth: "",
          phoneCountryCode: "",
          phoneAreaCode: "",
          phoneNumber: "",
          streetAddressLine1: "",
          streetAddressLine2: "",
          streetCity: "",
          streetRegion: "",
          streetPostalCode: "",
          streetCountry: "New Zealand",
          postalAddressLine1: "",
          postalAddressLine2: "",
          postalCity: "",
          postalRegion: "",
          postalPostalCode: "",
          postalCountry: "New Zealand",
        } as never
      }
      createPostalSameAsPhysical={false}
      onChangeCreateForm={vi.fn()}
      onChangeCreatePostalSameAsPhysical={vi.fn()}
      onChangeCreateAddressFields={vi.fn()}
      onSubmitCreate={onSubmitCreate}
      linkSearch=""
      linkSearching={false}
      linkSearchResults={[]}
      linkIneligibleMatches={[]}
      linkSearchMatchedNobody={false}
      linkSelected={
        {
          id: "target-1",
          firstName: "Kea",
          lastName: "Rangi",
          email: "kea@example.org",
          ageTier: "INFANT",
          active: true,
          canLogin: false,
          dateOfBirth: null,
          parentLinks: [],
        } as never
      }
      linkNotificationParentId=""
      linkDisableLogin={false}
      linkFamilyGroupIds={[]}
      onChangeLinkSearch={vi.fn()}
      onSelectLinkCandidate={vi.fn()}
      onClearLinkSelection={vi.fn()}
      onChangeLinkNotificationParentId={vi.fn()}
      onChangeLinkDisableLogin={vi.fn()}
      onToggleLinkFamilyGroup={vi.fn()}
      onSubmitLink={onSubmitLink}
      {...overrides}
    />,
  );
  return { onSubmitCreate, onSubmitLink };
}

afterEach(cleanup);

describe("MemberDependentsCard — who may be offered a dependant (#2282)", () => {
  it("offers Add Dependent on a YOUTH member", () => {
    const onOpen = renderCard(buildMember({ ageTier: "YOUTH" }));
    const button = screen.getByRole("button", { name: /add dependent/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });

  it("no longer claims only adults can manage dependents", () => {
    renderCard(buildMember({ ageTier: "YOUTH" }));
    expect(screen.queryByText(/only adult members/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/no dependents linked to this member yet/i),
    ).toBeInTheDocument();
  });

  it("disables the control WITH the reason for an inactive member", () => {
    const onOpen = renderCard(buildMember({ active: false }));
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.INACTIVE),
    ).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says ARCHIVED rather than INACTIVE for an archived member", () => {
    renderCard(
      buildMember({ active: false, archivedAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.ARCHIVED),
    ).toBeInTheDocument();
  });

  it("names the adult a dependant's club email would reach", () => {
    renderCard(
      buildMember({
        ageTier: "YOUTH",
        dependentEmailSource: {
          id: "gran-1",
          firstName: "Nan",
          lastName: "Rangi",
          email: "nan@example.org",
        },
      }),
    );
    expect(screen.getByText(/nan@example\.org/i)).toBeInTheDocument();
  });

  it("says so plainly when no adult in the family can receive mail", () => {
    renderCard(
      buildMember({ ageTier: "YOUTH", dependentEmailSource: null }),
    );
    expect(
      screen.getByText(/no adult in this family has a real email address/i),
    ).toBeInTheDocument();
  });

  it("stays quiet about routing when the member is their own source", () => {
    // The ordinary case. Saying "email goes to Tui Rangi" on Tui's own page is
    // noise, and noise is how the load-bearing sentence stops being read.
    renderCard(buildMember());
    expect(screen.queryByText(/goes to/i)).not.toBeInTheDocument();
  });
});

describe("MemberDependentDialog — both paths are gated, not one (#2282)", () => {
  it("blocks the CREATE tab with the create-path message", () => {
    const { onSubmitCreate } = renderDialog(
      buildMember({ active: false }),
      "create",
    );
    const submit = screen.getByRole("button", { name: /create dependent/i });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_CREATE_ERRORS.INACTIVE),
    ).toBeInTheDocument();
    fireEvent.click(submit);
    expect(onSubmitCreate).not.toHaveBeenCalled();
  });

  it("blocks the LINK tab with the link-path message", () => {
    const { onSubmitLink } = renderDialog(
      buildMember({ active: false }),
      "link",
    );
    const submit = screen.getByRole("button", { name: /link dependent/i });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_LINK_ERRORS.INACTIVE),
    ).toBeInTheDocument();
    fireEvent.click(submit);
    expect(onSubmitLink).not.toHaveBeenCalled();
  });

  it("leaves both paths usable on a YOUTH parent whose record is current", () => {
    const { onSubmitCreate } = renderDialog(
      buildMember({ ageTier: "YOUTH" }),
      "create",
    );
    const submit = screen.getByRole("button", { name: /create dependent/i });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmitCreate).toHaveBeenCalled();
  });

  it("tells the admin which mailbox a created dependant will inherit", () => {
    renderDialog(
      buildMember({
        ageTier: "YOUTH",
        dependentEmailSource: {
          id: "gran-1",
          firstName: "Nan",
          lastName: "Rangi",
          email: "nan@example.org",
        },
      }),
      "create",
    );
    expect(
      screen.getByText(/notifications for them go to Nan Rangi/i),
    ).toBeInTheDocument();
  });
});

/**
 * The SECOND entry point. `Add Dependent` sits in the page header toolbar as
 * well as on the Dependents card, and before #2282 both hid on the same
 * condition — so fixing one and not the other would leave the identical dead
 * end one scroll position away.
 */
describe("MemberDetailHeader — the toolbar copy of the same control (#2282)", () => {
  function renderHeader(member: MemberDetail, onOpen = vi.fn()) {
    render(
      <MemberDetailHeader
        member={member}
        backHref="/admin/members"
        backLabel="Members"
        pendingDeleteRequest={undefined}
        xeroConnected={false}
        xeroOrgShortCode={null}
        xeroPushing={false}
        xeroUnlinking={false}
        canEditMembership
        canEditFinance
        onOpenDependentDialog={onOpen}
        onOpenLinkXero={vi.fn()}
        onOpenCreateXero={vi.fn()}
        onUnlinkXero={vi.fn()}
      />,
    );
    return onOpen;
  }

  it("offers Add Dependent on a YOUTH member", () => {
    const onOpen = renderHeader(buildMember({ ageTier: "YOUTH" }));
    const button = screen.getByRole("button", { name: /add dependent/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });

  it("disables it WITH the reason when the member is inactive", () => {
    renderHeader(buildMember({ active: false }));
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.INACTIVE),
    ).toBeInTheDocument();
  });

  it("disables it WITH the reason when the member is archived", () => {
    renderHeader(
      buildMember({ active: false, archivedAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(screen.getByRole("button", { name: /add dependent/i })).toBeDisabled();
    expect(
      screen.getByText(DEPENDENT_PARENT_BLOCK_EXPLANATIONS.ARCHIVED),
    ).toBeInTheDocument();
  });
});
