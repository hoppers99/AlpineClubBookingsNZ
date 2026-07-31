// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MembershipCancellationSharedInvoiceNotice } from "@/components/admin/membership-cancellation-shared-invoice-notice";
import {
  buildMembershipCancellationSharedInvoiceMessage,
  formatMemberNameList,
  sharedInvoiceLabel,
  type MembershipCancellationSharedInvoiceNotice as SharedInvoiceNotice,
} from "@/lib/membership-cancellation-blocker-messages";

/**
 * The owner's decision (#2400) turns on this being VISIBLE: a cancellation that
 * quietly raises no credit note, when the standing policy says unpaid
 * subscriptions are credited, would replace one invisible problem with another.
 */

function notice(
  overrides: Partial<SharedInvoiceNotice> = {},
): SharedInvoiceNotice {
  return {
    invoiceId: "inv-1",
    invoiceNumber: "INV-0042",
    xeroUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1",
    sharedWith: [{ memberId: "member-2", name: "Bob Smith" }],
    blocksApproval: false,
    route: "cancel_others_first",
    ...overrides,
  };
}

describe("naming the members who are staying", () => {
  it("reads as a sentence for one, two and three names", () => {
    expect(formatMemberNameList(["Ada"])).toBe("Ada");
    expect(formatMemberNameList(["Ada", "Bob"])).toBe("Ada and Bob");
    expect(formatMemberNameList(["Ada", "Bob", "Cy"])).toBe("Ada, Bob and Cy");
  });

  it("summarises the tail rather than listing a whole club", () => {
    expect(
      formatMemberNameList(["A", "B", "C", "D", "E", "F", "G"]),
    ).toBe("A, B, C, D, E and 2 others");
    expect(formatMemberNameList(["A", "B", "C", "D", "E", "F"])).toBe(
      "A, B, C, D, E and 1 other",
    );
  });
});

describe("the shared-invoice notice wording", () => {
  it("names the invoice by number", () => {
    expect(sharedInvoiceLabel(notice())).toBe("invoice INV-0042");
  });

  it("falls back to the Xero id when Xero never numbered it", () => {
    expect(sharedInvoiceLabel(notice({ invoiceNumber: null }))).toContain(
      "inv-1",
    );
  });

  it("says what will happen, why, and what to do instead", () => {
    const message = buildMembershipCancellationSharedInvoiceMessage(notice());

    expect(message).toContain("invoice INV-0042");
    expect(message).toContain("Bob Smith");
    expect(message).toContain("no Xero credit note");
    expect(message).toContain("the approval itself goes ahead");
    expect(message).toContain("raise that credit note yourself in Xero");
    expect(message).toContain("approve them first");
  });

  // #2400 (review F2). The family invoice is raised to the charge RECIPIENT's
  // Xero contact, so the commonest shape — a parent leaving while the children
  // stay — is REFUSED, not merely uncredited. The old wording said "The invoice
  // is left exactly as it is" and then the Approve button 409'd.
  it("says the approval will be refused when the invoice is one of the blockers", () => {
    const message = buildMembershipCancellationSharedInvoiceMessage(
      notice({ blocksApproval: true }),
    );

    expect(message).toContain("approval is refused until this invoice is paid");
    expect(message).not.toContain("the approval itself goes ahead");
  });

  // #2400 (review F4). Email-inheriting children resolve to their parent's Xero
  // contact, so every member the invoice covers is refused at once and there is
  // no first move. Telling the reviewer to "approve them first" sends them round
  // a loop they will try on every member before giving up.
  it("does not send the reviewer round a loop when the family shares one Xero contact", () => {
    const message = buildMembershipCancellationSharedInvoiceMessage(
      notice({ blocksApproval: true, route: "shared_xero_contact" }),
    );

    expect(message).not.toContain("approve them first");
    expect(message).toContain("Approving the others first will not help here");
    expect(message).toContain("Settle, credit or void the invoice in Xero");
  });

  // The same sentence is unfollowable when the members holding the invoice open
  // were DEACTIVATED rather than cancelled: an inactive membership cannot be
  // approved for cancellation at all.
  it("does not advise approving members who cannot be approved", () => {
    const message = buildMembershipCancellationSharedInvoiceMessage(
      notice({ route: "remaining_not_cancellable" }),
    );

    expect(message).not.toContain("approve them first");
    expect(message).toContain("There is nobody to approve first");
    expect(message).toContain("deactivated rather than cancelled");
  });
});

describe("the panel the reviewer reads", () => {
  it("renders the explanation with the invoice linked into Xero", () => {
    render(<MembershipCancellationSharedInvoiceNotice notice={notice()} />);

    expect(
      screen.getByText(
        "No Xero credit note will be raised for this cancellation.",
      ),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: "invoice INV-0042" });
    expect(link.getAttribute("href")).toBe(
      "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getByText(/Bob Smith/)).toBeTruthy();
  });

  it("heads the panel with the refusal when the invoice is blocking the approval", () => {
    render(
      <MembershipCancellationSharedInvoiceNotice
        notice={notice({ blocksApproval: true })}
      />,
    );

    expect(
      screen.getByText(
        "This cancellation credits nothing, and the invoice it leaves behind is blocking the approval.",
      ),
    ).toBeTruthy();
  });

  it("shows nothing when the cancellation will credit the invoice in full", () => {
    const { container } = render(
      <MembershipCancellationSharedInvoiceNotice notice={null} />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("shows nothing rather than a notice naming nobody", () => {
    const { container } = render(
      <MembershipCancellationSharedInvoiceNotice
        notice={notice({ sharedWith: [] })}
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});
