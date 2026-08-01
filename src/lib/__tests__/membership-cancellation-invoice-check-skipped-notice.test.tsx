// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  MembershipCancellationInvoiceCheckSkippedLine,
  MembershipCancellationInvoiceCheckSkippedNotice,
} from "@/components/admin/membership-cancellation-invoice-check-skipped-notice";

/**
 * #2402: the owner accepted that a view-only admin stops being told money is
 * owing. What was NOT accepted is that they be left to read the resulting
 * silence as good news — so the honesty of this wording is the feature, not
 * decoration.
 *
 * It has to be honest in BOTH directions. Only the Xero half is skipped; the
 * booking blockers are still loaded and still shown, so a note implying the
 * whole row went unchecked would mislead just as badly (#2402 review, F1).
 */
describe("membership cancellation invoice-check-skipped notice (#2402)", () => {
  it("says nothing at all when every check ran", () => {
    const { container } = render(
      <MembershipCancellationInvoiceCheckSkippedNotice count={0} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says the question was not asked, and never that nothing is owing", () => {
    render(<MembershipCancellationInvoiceCheckSkippedNotice count={1} />);

    const text = document.body.textContent ?? "";
    // The distinction the notice exists to draw.
    expect(text).toMatch(/the question was not asked/i);
    // It names BOTH checks it stands in for — the Xero one and the
    // shared-family-invoice one — because both go quiet together.
    expect(text).toMatch(/Xero/);
    expect(text).toMatch(/shared family invoice/i);
    // And says why, so the reader knows this is about their permissions rather
    // than a fault.
    expect(text).toMatch(/cannot approve/i);
    // No form of words that could be read as a clean bill of health.
    expect(text).not.toMatch(/no blockers/i);
    expect(text).not.toMatch(/nothing is owing/i);
  });

  it("does not claim the booking side went unchecked either (F1)", () => {
    render(<MembershipCancellationInvoiceCheckSkippedNotice count={2} />);

    const text = document.body.textContent ?? "";
    // Bookings ARE checked for everyone, and the notice says so rather than
    // leaving the reader to assume the whole row is unknown.
    expect(text).toMatch(
      /bookings and guest appearances are checked for everyone/i,
    );
    expect(text).toMatch(/complete/i);
  });

  it("counts the members it applies to, so one panel can serve a family", () => {
    const { rerender } = render(
      <MembershipCancellationInvoiceCheckSkippedNotice count={1} />,
    );
    expect(screen.getByText(/for one member below/i)).toBeInTheDocument();

    rerender(<MembershipCancellationInvoiceCheckSkippedNotice count={3} />);
    expect(screen.getByText(/for 3 members below/i)).toBeInTheDocument();
  });

  it("marks the affected rows with one short line, not the whole paragraph", () => {
    const { container } = render(
      <MembershipCancellationInvoiceCheckSkippedLine skipped={false} />,
    );
    expect(container).toBeEmptyDOMElement();

    render(<MembershipCancellationInvoiceCheckSkippedLine skipped />);
    const line = screen.getByText(/Money-owing check not run for this member/i);
    expect(line).toBeInTheDocument();
    // Short by construction: the explanation lives once at request level.
    expect((line.textContent ?? "").length).toBeLessThan(120);
  });
});
