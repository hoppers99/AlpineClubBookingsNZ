import { describe, expect, it } from "vitest";
import { buildXeroEntranceFeeInvoiceOptions } from "@/lib/admin-xero-entrance-fee";

describe("buildXeroEntranceFeeInvoiceOptions", () => {
  describe("when the operator chooses NOT to create an invoice", () => {
    it("requires a non-empty skip reason", () => {
      expect(() =>
        buildXeroEntranceFeeInvoiceOptions({
          createEntranceFeeInvoice: false,
          skipReason: "",
          amount: "",
          narration: "",
        }),
      ).toThrow("Enter a reason for not raising the joining fee invoice.");
    });

    it("rejects a whitespace-only skip reason", () => {
      expect(() =>
        buildXeroEntranceFeeInvoiceOptions({
          createEntranceFeeInvoice: false,
          skipReason: "   ",
          amount: "",
          narration: "",
        }),
      ).toThrow("Enter a reason for not raising the joining fee invoice.");
    });

    it("returns a SKIP decision with the trimmed reason", () => {
      expect(
        buildXeroEntranceFeeInvoiceOptions({
          createEntranceFeeInvoice: false,
          skipReason: "  paid by employer  ",
          amount: "ignored",
          narration: "ignored",
        }),
      ).toEqual({
        createEntranceFeeInvoice: false,
        entranceFeeInvoiceDecision: "SKIP",
        entranceFeeInvoiceSkipReason: "paid by employer",
      });
    });
  });

  describe("when the operator chooses to create an invoice", () => {
    it("returns a CREATE decision with no overrides when amount and narration are blank", () => {
      expect(
        buildXeroEntranceFeeInvoiceOptions({
          createEntranceFeeInvoice: true,
          skipReason: "",
          amount: "",
          narration: "",
        }),
      ).toEqual({
        createEntranceFeeInvoice: true,
        entranceFeeInvoiceDecision: "CREATE",
      });
    });

    it("converts dollar amounts to cents", () => {
      const result = buildXeroEntranceFeeInvoiceOptions({
        createEntranceFeeInvoice: true,
        skipReason: "",
        amount: "150.50",
        narration: "",
      });
      expect(result.entranceFeeInvoiceAmountCents).toBe(15050);
    });

    /*
      #2685 — this used to assert only that an over-precise amount stayed an
      INTEGER, with a comment noting that `10.005 * 100` is 1000.4999… and
      therefore rounds DOWN to $10.00. That pinned the defect as acceptable: the
      operator typed three decimal places and the form quietly picked a cent for
      them, in the less generous direction, on a joining-fee invoice.

      The owner's decision (9 Aug 2026) is that unsupported precision in a typed
      amount is refused with a message the operator can act on, never coerced.
      The joining fee is a member's money and an accounting document, so guessing
      is the wrong answer even when the guess is only a cent.
    */
    it("refuses an amount with unsupported precision rather than picking a cent", () => {
      expect(() =>
        buildXeroEntranceFeeInvoiceOptions({
          createEntranceFeeInvoice: true,
          skipReason: "",
          amount: "10.005",
          narration: "",
        }),
      ).toThrow(/Enter a valid joining fee amount/);
    });

    it.each(["10abc", "1,000.00", "$10.00", "1e2", "10.00.00", "-10.00"])(
      "refuses the malformed amount %s",
      (amount) => {
        expect(() =>
          buildXeroEntranceFeeInvoiceOptions({
            createEntranceFeeInvoice: true,
            skipReason: "",
            amount,
            narration: "",
          }),
        ).toThrow(/Enter a valid joining fee amount/);
      },
    );

    it("rejects zero amounts", () => {
      expect(() =>
        buildXeroEntranceFeeInvoiceOptions({
          createEntranceFeeInvoice: true,
          skipReason: "",
          amount: "0",
          narration: "",
        }),
      ).toThrow("Enter a valid joining fee amount");
    });

    it("rejects negative amounts", () => {
      expect(() =>
        buildXeroEntranceFeeInvoiceOptions({
          createEntranceFeeInvoice: true,
          skipReason: "",
          amount: "-10",
          narration: "",
        }),
      ).toThrow("Enter a valid joining fee amount");
    });

    it("rejects non-numeric amounts", () => {
      expect(() =>
        buildXeroEntranceFeeInvoiceOptions({
          createEntranceFeeInvoice: true,
          skipReason: "",
          amount: "abc",
          narration: "",
        }),
      ).toThrow("Enter a valid joining fee amount");
    });

    it("trims and includes narration when provided", () => {
      const result = buildXeroEntranceFeeInvoiceOptions({
        createEntranceFeeInvoice: true,
        skipReason: "",
        amount: "",
        narration: "  Initial joining fee 2026  ",
      });
      expect(result.entranceFeeInvoiceNarration).toBe("Initial joining fee 2026");
    });

    it("omits narration field when blank or whitespace-only", () => {
      const result = buildXeroEntranceFeeInvoiceOptions({
        createEntranceFeeInvoice: true,
        skipReason: "",
        amount: "",
        narration: "   ",
      });
      expect(result).not.toHaveProperty("entranceFeeInvoiceNarration");
    });

    it("ignores the skip reason when creating an invoice", () => {
      const result = buildXeroEntranceFeeInvoiceOptions({
        createEntranceFeeInvoice: true,
        skipReason: "this would be wrong",
        amount: "",
        narration: "",
      });
      expect(result).not.toHaveProperty("entranceFeeInvoiceSkipReason");
    });
  });
});
