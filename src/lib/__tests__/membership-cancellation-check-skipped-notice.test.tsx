// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MembershipCancellationCheckSkippedNotice } from "@/components/admin/membership-cancellation-check-skipped-notice";

/**
 * #2402: the owner accepted that a view-only admin stops being told money is
 * owing. What was NOT accepted is that they be left to read the resulting
 * silence as good news — so the honesty of this wording is the feature, not
 * decoration.
 */
describe("membership cancellation check-skipped notice (#2402)", () => {
  it("says nothing at all when the checks did run", () => {
    const { container } = render(
      <MembershipCancellationCheckSkippedNotice skipped={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says the question was not asked, and never that nothing is owing", () => {
    render(<MembershipCancellationCheckSkippedNotice skipped />);

    expect(
      screen.getByText(/Approval checks were not run for this member/i),
    ).toBeInTheDocument();

    const text = document.body.textContent ?? "";
    // The distinction the notice exists to draw.
    expect(text).toMatch(/the question was not asked/i);
    // It must name BOTH checks it is standing in for — the Xero one and the
    // shared-family-invoice one — because both go quiet together.
    expect(text).toMatch(/Xero/);
    expect(text).toMatch(/shared family invoice/i);
    // And it must say why, so the reader knows this is about their permissions
    // rather than a fault.
    expect(text).toMatch(/cannot approve/i);
    // No form of words that could be read as a clean bill of health.
    expect(text).not.toMatch(/no blockers/i);
    expect(text).not.toMatch(/nothing is owing/i);
  });
});
