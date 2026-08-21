// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyFilters } from "../../_utils";
import { MemberFilterToolbar } from "../member-filter-toolbar";

/**
 * The members filter toolbar rendered against the REAL `@/components/ui/select`.
 *
 * WHY THIS FILE EXISTS, AND WHY IT DELIBERATELY MOCKS ALMOST NOTHING.
 * Every other suite in this folder replaces the select module with plain divs.
 * That is reasonable for asserting copy and wiring, but it means the whole
 * Radix runtime — its contexts, and the invariants they enforce — is never
 * exercised anywhere in the unit tests. A `SelectLabel` was added to the
 * Membership Type picker outside a `SelectGroup`; every mocked suite passed,
 * and the members page crashed to its error boundary in a real browser, taking
 * out the E2E that loads `/admin/members`.
 *
 * The trap is that it does NOT need the picker to be opened. A CLOSED Radix
 * `SelectContent` still portals its children into a detached DocumentFragment
 * so it can collect them, so a child that throws on mount throws on PAGE LOAD.
 * `SelectLabel` reads the group context and throws without it:
 * "`SelectLabel` must be used within `SelectGroup`".
 *
 * So the assertion here is deliberately shallow — that the toolbar MOUNTS. The
 * value is entirely in the real module being present, not in what is asserted.
 */

// Option sources fetch in the browser; pin them so this file tests rendering.
vi.mock("@/hooks/use-access-role-options", async () => {
  const { buildFallbackAccessRoleOptions } = await import(
    "@/lib/access-role-definitions"
  );
  const options = buildFallbackAccessRoleOptions();
  return { useAccessRoleOptions: () => options };
});

function renderToolbar() {
  return render(
    <MemberFilterToolbar
      search=""
      filters={emptyFilters}
      // Non-empty on purpose: the picker then renders its club types beside the
      // label, which is the arrangement that shipped broken.
      membershipTypes={[
        { id: "mt-full", key: "FULL", name: "Full", isActive: true },
        { id: "mt-nonmember", key: "NON_MEMBER", name: "Non-Member", isActive: true },
      ]}
      xeroFeatures={{ liveMemberGroupLookups: false, autoLoadContactGroups: false }}
      xeroContactGroupsList={[]}
      onSearchChange={vi.fn()}
      onSetFilter={vi.fn()}
      resetDisabled={true}
      onReset={vi.fn()}
    />,
  );
}

describe("members filter toolbar against the real select primitives (#2978)", () => {
  afterEach(() => cleanup());

  it("mounts without throwing, with every Select still closed", () => {
    // If a Select child violates a Radix context invariant, this render throws
    // and the whole page it belongs to fails the same way in the browser.
    expect(() => renderToolbar()).not.toThrow();
  });

  it("renders the Membership Type picker's trigger", () => {
    renderToolbar();

    expect(
      screen.getByRole("combobox", { name: /membership type/i }),
    ).toBeInTheDocument();
  });
});
