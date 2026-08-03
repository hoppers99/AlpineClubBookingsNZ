// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FamilyGroupRequestReviewCard } from "@/components/admin/family-groups/request-review-card";
import type {
  FamilyGroupRequest,
  RequestMemberMatch,
} from "@/lib/admin-family-group-ui-helpers";

/**
 * How the calculated age is PRESENTED on the request review card (#2568).
 *
 * The value itself is the server's finished string, so nothing here checks
 * arithmetic — that is `member-age.test.ts`. What is checked here is that the
 * age reaches every identity-sensitive part of the card, that it is real visible
 * text rather than a hover-only tooltip, and that a member record's date of birth
 * is no longer rendered anywhere.
 */

afterEach(cleanup);

const noopHandlers = {
  onSelectMember: vi.fn(),
  onSearchTermChange: vi.fn(),
  onSearchMembers: vi.fn(),
  onNotificationParentChange: vi.fn(),
  onNoteChange: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onClearRequestFeedback: vi.fn(),
};

const REQUESTER = {
  id: "parent-1",
  firstName: "John",
  lastName: "Smith",
  email: "smiths@example.com",
  ageLabel: "52 years",
};

function buildMatch(overrides: Partial<RequestMemberMatch> = {}): RequestMemberMatch {
  return {
    id: "child-1",
    firstName: "John",
    lastName: "Smith",
    email: "smiths@example.com",
    ageTier: "ADULT",
    active: true,
    canLogin: false,
    ageLabel: "19 years",
    alreadyInGroup: false,
    parentLinks: [],
    ...overrides,
  };
}

function buildChildRequest(
  overrides: Partial<FamilyGroupRequest> = {}
): FamilyGroupRequest {
  return {
    id: "req-child",
    type: "CHILD_REQUEST",
    createdAt: "2026-06-01T00:00:00.000Z",
    requester: { ...REQUESTER },
    familyGroup: { id: "group-1", name: "Smith Family", members: [] },
    childFirstName: "Ivy",
    childLastName: "Smith",
    childDateOfBirth: "2022-10-20",
    childAgeLabel: "3 years 8 months",
    matchingMembers: [],
    ...overrides,
  };
}

function renderCard(request: FamilyGroupRequest, props: Partial<Parameters<typeof FamilyGroupRequestReviewCard>[0]> = {}) {
  return render(
    <FamilyGroupRequestReviewCard
      request={request}
      searchedMembers={[]}
      searching={false}
      submitting={false}
      canEdit
      showRemovalDetails
      {...noopHandlers}
      {...props}
    />
  );
}

describe("request review card — where the age appears (#2568)", () => {
  it("shows the requester's age beside their name", () => {
    renderCard(buildChildRequest());

    expect(screen.getByText("Requester")).toBeTruthy();
    expect(screen.getByText("52 years")).toBeTruthy();
  });

  it("shows the declared age of the person being added, beside the declared DOB", () => {
    renderCard(buildChildRequest());

    expect(screen.getByText(/Person to add/)).toBeTruthy();
    expect(screen.getByText("3 years 8 months")).toBeTruthy();
  });

  it("shows each suggested match's age next to its name, and no date of birth", () => {
    const { container } = renderCard(buildChildRequest(), {
      searchedMembers: [
        buildMatch({ id: "older", ageLabel: "52 years" }),
        buildMatch({ id: "younger", ageLabel: "19 years" }),
      ],
    });

    // Two identically-named candidates, told apart only by age.
    expect(screen.getAllByText("52 years").length).toBeGreaterThan(0);
    expect(screen.getAllByText("19 years").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("DOB 20 Oct 2022");
  });

  it("shows the age on the selected-member confirmation panel", () => {
    renderCard(buildChildRequest({ matchingMembers: [buildMatch()] }), {
      requestSelection: "child-1",
    });

    expect(
      screen.getByText(/Selected member record — check this is the right person/)
    ).toBeTruthy();
    expect(screen.getAllByText("19 years").length).toBeGreaterThan(0);
  });

  it("shows the age in the picker's option text, where markup is not possible", () => {
    renderCard(
      buildChildRequest({
        matchingMembers: [
          buildMatch({ id: "older", ageLabel: "52 years" }),
          buildMatch({ id: "younger", ageLabel: "19 years" }),
        ],
      })
    );

    const options = screen.getAllByRole("option");
    const optionText = options.map((option) => option.textContent ?? "");
    expect(optionText.some((text) => text.includes("52 years"))).toBe(true);
    expect(optionText.some((text) => text.includes("19 years"))).toBe(true);
  });

  it("shows the age of the member being removed", () => {
    renderCard(
      buildChildRequest({
        id: "req-removal",
        type: "REMOVAL_REQUEST",
        childDateOfBirth: null,
        childAgeLabel: null,
        subjectMember: {
          id: "child-1",
          firstName: "John",
          lastName: "Smith",
          email: "smiths@example.com",
          ageTier: "ADULT",
          active: true,
          ageLabel: "19 years",
        },
      })
    );

    expect(screen.getByText(/Member to remove/)).toBeTruthy();
    expect(screen.getByText("19 years")).toBeTruthy();
  });

  it("shows the age of the partner a group-creation approval would invite", () => {
    renderCard(
      buildChildRequest({
        id: "req-create",
        type: "GROUP_CREATE",
        invitedMember: {
          id: "partner-1",
          firstName: "Ada",
          lastName: "Smith",
          email: "ada@example.com",
          ageLabel: "49 years",
        },
      })
    );

    expect(screen.getByText("49 years")).toBeTruthy();
  });

  it("shows the age of a brand-new record about to be created", () => {
    renderCard(
      buildChildRequest({
        canCreateMemberFromRequest: true,
        requestedAgeTierLabel: "Infant (0-4)",
      }),
      { requestSelection: "__create__" }
    );

    expect(screen.getByText(/New non-login dependant will be created/)).toBeTruthy();
    expect(screen.getAllByText("3 years 8 months").length).toBeGreaterThan(0);
  });

  it("shows Age unavailable when the server could not derive one", () => {
    renderCard(buildChildRequest({ childAgeLabel: "Age unavailable" }), {
      searchedMembers: [buildMatch({ ageLabel: "Age unavailable" })],
    });

    expect(screen.getAllByText("Age unavailable").length).toBeGreaterThan(0);
  });
});

describe("request review card — presentation rules (#2568)", () => {
  it("renders the age as visible text, never as a hover-only tooltip", () => {
    const { container } = renderCard(buildChildRequest(), {
      searchedMembers: [buildMatch()],
    });

    // Nothing on the card hides an age behind `title`, which a touch or
    // keyboard user could never reveal.
    for (const element of Array.from(container.querySelectorAll("[title]"))) {
      expect(element.getAttribute("title")).not.toContain("years");
      expect(element.getAttribute("title")).not.toContain("Age");
    }
    expect(screen.getByText("52 years").textContent).toBe("52 years");
  });

  it("announces the chip as an age to a screen reader", () => {
    renderCard(buildChildRequest(), { searchedMembers: [buildMatch()] });

    const chip = screen.getByText("19 years");
    expect(chip.textContent).toBe("Age 19 years");
  });

  it("keeps an age value from breaking across lines, and lets long names wrap", () => {
    const { container } = renderCard(
      buildChildRequest({
        requester: {
          ...REQUESTER,
          firstName: "Bartholomew-Fitzwilliam",
          lastName: "Cholmondeley-Featherstonehaugh",
        },
      }),
      {
        searchedMembers: [
          buildMatch({
            firstName: "Bartholomew-Fitzwilliam",
            lastName: "Cholmondeley-Featherstonehaugh",
            ageLabel: "3 years 8 months",
          }),
        ],
      }
    );

    // The value itself never splits mid-way — true of both presentations, the
    // chip beside a name and the labelled line in a confirmation panel.
    const renderings = screen.getAllByText("3 years 8 months");
    expect(renderings.length).toBeGreaterThan(1);
    for (const rendering of renderings) {
      expect(rendering.className).toContain("whitespace-nowrap");
    }
    // ...while the chip's row wraps, so a long name pushes it down rather than
    // off the card.
    const chip = renderings.find((rendering) =>
      rendering.textContent?.startsWith("Age ")
    );
    expect(chip).toBeTruthy();
    expect(chip?.parentElement?.className).toContain("flex-wrap");
    expect(container.querySelectorAll(".break-words").length).toBeGreaterThan(0);
  });

  it("renders nothing at all when a payload carries no age", () => {
    const { container } = renderCard(
      buildChildRequest({
        requester: { ...REQUESTER, ageLabel: undefined },
        childAgeLabel: null,
      })
    );

    expect(container.textContent).not.toContain("Age:");
    expect(container.textContent).not.toContain("52 years");
  });
});
