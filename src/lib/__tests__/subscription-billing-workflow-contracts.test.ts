import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("subscription billing workflow durability contracts", () => {
  const source = fs.readFileSync(path.resolve("src/lib/xero-subscription-invoices.ts"), "utf8");

  it("persists invoice identifiers before attempting email and resumes from the persisted identifier", () => {
    const persistence = source.indexOf("invoicePersistedAt:");
    const email = source.indexOf("accountingApi.emailInvoice");
    expect(persistence).toBeGreaterThan(0);
    expect(email).toBeGreaterThan(persistence);
    expect(source).toContain("if (!invoiceId)");
    expect(source).toContain("charge.xeroInvoiceId");
  });

  it("flags provider mismatch and duplicate references without an updateInvoices rewrite", () => {
    expect(source).toContain('lastErrorCode: "PROVIDER_MISMATCH"');
    expect(source).toContain('lastErrorCode: "DUPLICATE_REFERENCE"');
    expect(source).not.toContain("updateInvoices(");
  });

  it("uses AUTHORISED GST-inclusive invoices and the subscriptionIncome mapping", () => {
    expect(source).toContain('getResolvedAccountMapping("subscriptionIncome")');
    expect(source).toContain("Invoice.StatusEnum.AUTHORISED");
    expect(source).toContain("LineAmountTypes.Inclusive");
    expect(source).toContain('taxType: "OUTPUT2"');
  });

  it("keeps email failure retryable with a stable invoice-email key", () => {
    expect(source).toContain('status: "EMAIL_FAILED"');
    expect(source).toContain('emailAttemptCount: { increment: 1 }');
    expect(source).toContain('"invoice-email", invoiceId, "v1"');
  });
});
