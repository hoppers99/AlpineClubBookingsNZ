import { describe, expect, it } from "vitest";
import {
  buildMembershipCancellationApprovalBlockedMessage,
  describeMembershipCancellationBlocker,
  membershipCancellationBlockerHeading,
  membershipCancellationBlockerHint,
  type MembershipCancellationBlocker,
  type MembershipCancellationUnpaidInvoiceBlocker,
} from "@/lib/membership-cancellation-blocker-messages";

function unpaidInvoice(
  overrides: Partial<MembershipCancellationUnpaidInvoiceBlocker> = {},
): MembershipCancellationUnpaidInvoiceBlocker {
  return {
    type: "unpaid_invoice",
    invoiceId: "inv-1",
    invoiceNumber: "INV-0042",
    invoiceStatus: "AUTHORISED",
    direction: "receivable",
    amountDueCents: 12050,
    currency: "NZD",
    dueDate: "2026-06-30",
    xeroUrl: null,
    ...overrides,
  };
}

const ownedBooking: MembershipCancellationBlocker = {
  type: "owned_booking",
  bookingId: "booking-1",
  bookingStatus: "PAID",
  checkIn: "2099-01-01T00:00:00.000Z",
  checkOut: "2099-01-03T00:00:00.000Z",
};

describe("membership cancellation blocker wording", () => {
  it("names the invoice, its balance, its status and its due date", () => {
    expect(describeMembershipCancellationBlocker(unpaidInvoice())).toBe(
      "Invoice INV-0042 — NZD 120.50 still owing (AUTHORISED, due 2026-06-30)",
    );
  });

  it("calls a payable a bill", () => {
    expect(
      describeMembershipCancellationBlocker(
        unpaidInvoice({ direction: "payable", invoiceNumber: "BILL-9" }),
      ),
    ).toContain("Bill BILL-9");
  });

  it("falls back to the Xero id when an invoice has no number", () => {
    expect(
      describeMembershipCancellationBlocker(
        unpaidInvoice({ invoiceNumber: null }),
      ),
    ).toContain("Xero invoice inv-1");
  });

  it("leaves an unknown currency off rather than guessing one", () => {
    expect(
      describeMembershipCancellationBlocker(
        unpaidInvoice({ currency: "UNKNOWN" }),
      ),
    ).toContain("120.50 still owing");
  });

  it("keeps the existing booking wording, and honours a caller's date format", () => {
    expect(
      describeMembershipCancellationBlocker(ownedBooking, {
        formatDate: (value) => `[${value.slice(0, 10)}]`,
      }),
    ).toBe("Owned booking booking-1 (PAID) from [2099-01-01] to [2099-01-03]");
  });

  describe("the approval refusal", () => {
    it("names the invoices and says how to clear them", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        unpaidInvoice(),
        unpaidInvoice({ invoiceId: "inv-2", invoiceNumber: "INV-0051", amountDueCents: 8000 }),
      ]);

      expect(message).toContain("INV-0042 (NZD 120.50)");
      expect(message).toContain("INV-0051 (NZD 80.00)");
      expect(message).toContain("paid, credited with an allocated credit note, or voided in Xero");
      expect(message).toContain(
        '"Archive Xero contacts after cancellation approval"',
      );
    });

    it("caps the named invoices and says how many more there are", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage(
        Array.from({ length: 8 }, (_, index) =>
          unpaidInvoice({
            invoiceId: `inv-${index}`,
            invoiceNumber: `INV-${index}`,
          }),
        ),
      );

      expect(message).toContain("INV-4");
      expect(message).not.toContain("INV-5");
      expect(message).toContain("and 3 more");
    });

    it("keeps the booking sentence unchanged, and combines it with the invoice one", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        ownedBooking,
        unpaidInvoice(),
      ]);

      expect(message).toContain(
        "Approval is blocked while this member has future bookings or guest appearances.",
      );
      expect(message).toContain("INV-0042");
    });

    it("explains a disconnected Xero and offers two ways out", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        { type: "invoice_check_unavailable", reason: "disconnected" },
      ]);

      expect(message).toContain("Xero is not connected");
      expect(message).toContain("Reconnect Xero");
      expect(message).toContain(
        '"Archive Xero contacts after cancellation approval"',
      );
    });

    it("tells the approver to wait when Xero is only temporarily unreachable", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        { type: "invoice_check_unavailable", reason: "unavailable" },
      ]);

      expect(message).toContain("could not be reached");
      expect(message).toContain("Try again in a few minutes");
      expect(message).not.toContain("Reconnect Xero");
    });

    it("names the API limit when that is what stopped the check", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        { type: "invoice_check_unavailable", reason: "rate_limited" },
      ]);

      expect(message).toContain("API limit");
      expect(message).toContain("once the limit resets");
    });
  });

  describe("the review queue panel", () => {
    it("heads a booking-only panel the way it always did", () => {
      expect(membershipCancellationBlockerHeading([ownedBooking])).toBe(
        "Resolve these bookings before approval.",
      );
      expect(membershipCancellationBlockerHint([ownedBooking])).toBeNull();
    });

    it("heads an invoice panel with the money framing and offers a route out", () => {
      expect(membershipCancellationBlockerHeading([unpaidInvoice()])).toBe(
        "Settle these in Xero before approval.",
      );
      expect(membershipCancellationBlockerHint([unpaidInvoice()])).toContain(
        "void or credit it",
      );
    });

    it("heads a mixed panel neutrally", () => {
      expect(
        membershipCancellationBlockerHeading([ownedBooking, unpaidInvoice()]),
      ).toBe("Resolve these before approval.");
    });

    it("explains the check itself when that is all that is wrong", () => {
      const blockers: MembershipCancellationBlocker[] = [
        { type: "invoice_check_unavailable", reason: "disconnected" },
      ];
      expect(membershipCancellationBlockerHeading(blockers)).toBe(
        "Approval cannot be checked yet.",
      );
      expect(membershipCancellationBlockerHint(blockers)).toContain(
        "the check has to run first",
      );
    });
  });
});
