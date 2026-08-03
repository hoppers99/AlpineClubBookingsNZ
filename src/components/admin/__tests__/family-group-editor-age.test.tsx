// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The family-group EDITOR is where an administrator picks which specific members
 * stay in a group, adds one by search, or removes one with the pill's X (#2568).
 * Every one of those is an identity-sensitive action, so each pill and each
 * search row carries the calculated age — and no date of birth.
 */

const searchResults = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("@/hooks/use-debounced-member-search", () => ({
  useDebouncedMemberSearch: (options: { endpoint?: string }) => {
    lastSearchEndpoint.current = options.endpoint;
    return {
      results: searchResults.current,
      searching: false,
      error: "",
      total: searchResults.current.length,
      active: searchResults.current.length > 0,
    };
  },
}));

const lastSearchEndpoint = vi.hoisted(() => ({ current: undefined as string | undefined }));

vi.mock("@/components/admin/family-groups/request-review-section", () => ({
  FamilyGroupRequestReviewSection: () => <div data-testid="review-section" />,
}));

import { FamilyGroupEditor } from "@/components/admin/family-group-editor";

const GROUP_PAYLOAD = {
  id: "fg-1",
  name: "Smith Family",
  createdAt: "2026-01-01T00:00:00.000Z",
  members: [
    {
      id: "parent-1",
      firstName: "John",
      lastName: "Smith",
      email: "smiths@example.com",
      ageTier: "ADULT",
      active: true,
      canLogin: true,
      ageLabel: "52 years",
    },
    {
      id: "child-1",
      firstName: "John",
      lastName: "Smith",
      email: "smiths@example.com",
      ageTier: "ADULT",
      active: true,
      canLogin: false,
      ageLabel: "19 years",
    },
    {
      id: "toddler-1",
      firstName: "Ivy",
      lastName: "Smith",
      email: "smiths@example.com",
      ageTier: "INFANT",
      active: true,
      canLogin: false,
      ageLabel: "3 years 8 months",
    },
  ],
};

beforeEach(() => {
  searchResults.current = [];
  lastSearchEndpoint.current = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/admin/family-groups/requests")) {
        return new Response(JSON.stringify({ requests: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(GROUP_PAYLOAD), { status: 200 });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderEditor() {
  return render(
    <FamilyGroupEditor groupId="fg-1" onClose={vi.fn()} canEdit={true} />
  );
}

describe("family group editor — member pills (#2568)", () => {
  it("shows each member's age on the pill whose X removes them", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByText("Edit Family Group")).toBeTruthy());

    // Two identically-named adults in one group; the age is what separates them.
    // They also share an email address, so both appear a second time in the
    // shared-email login-holder picker — hence getAllByText.
    expect(screen.getAllByText("52 years").length).toBeGreaterThan(0);
    expect(screen.getAllByText("19 years").length).toBeGreaterThan(0);
    expect(screen.getByText("3 years 8 months")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Remove John Smith" })
    ).toHaveLength(2);
  });

  it("shows each candidate's age in the shared-email login-holder picker", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByText("Shared email & login")).toBeTruthy());

    // Both adults share smiths@example.com, so the radio list is the decision
    // that needs the age: same name, same address, same age tier.
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      const row = radio.closest("label");
      expect(row?.textContent).toMatch(/Age (52|19) years/);
    }
  });

  it("renders no date of birth anywhere in the editor", async () => {
    const { container } = renderEditor();

    await waitFor(() => expect(screen.getByText("Edit Family Group")).toBeTruthy());

    expect(container.textContent).not.toContain("DOB");
    expect(container.textContent).not.toContain("Date of birth");
  });

  it("keeps a long name and an age inside a wrapping pill", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByText("Edit Family Group")).toBeTruthy());

    const chip = screen.getByText("3 years 8 months");
    expect(chip.className).toContain("whitespace-nowrap");
    // The pill itself wraps rather than overflowing the row.
    expect(chip.parentElement?.className).toContain("flex-wrap");
    expect(chip.parentElement?.className).toContain("max-w-full");
  });
});

describe("family group editor — member search (#2568)", () => {
  it("searches the family-group lookup, not the members admin endpoint", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByText("Edit Family Group")).toBeTruthy());

    expect(lastSearchEndpoint.current).toBe(
      "/api/admin/family-groups/member-search"
    );
  });

  it("shows the age on each search row before it is linked", async () => {
    searchResults.current = [
      {
        id: "candidate-1",
        firstName: "John",
        lastName: "Smith",
        email: "another@example.com",
        ageLabel: "47 years",
      },
    ];
    renderEditor();

    await waitFor(() => expect(screen.getByText("Edit Family Group")).toBeTruthy());

    expect(screen.getByText("47 years")).toBeTruthy();
  });
});
