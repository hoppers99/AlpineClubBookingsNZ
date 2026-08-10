import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("./prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sanitizeForJson } from "@/lib/xero-sync";

/**
 * INV-PRIV-011 (#2683 review finding 8).
 *
 * `sanitizeForJson` is the writer for `XeroSyncOperation.requestPayload` and
 * `responsePayload` at ~20 call sites, several of which are read-modify-write
 * cycles that read the stored payload back and persist it again. It is not a
 * log line, so the log depth cap does not belong on it: applied there it was
 * measured deleting `lineItems[].tracking` from an invoice update, permanently,
 * and again on every subsequent pass. It does need the circular guard, which it
 * had none of at all.
 */
describe("sanitizeForJson", () => {
  it("keeps a Xero invoice payload whole past the log depth cap", () => {
    const payload = {
      invoices: [
        {
          invoiceID: "inv-1",
          lineItems: [
            {
              description: "Bunk night",
              unitAmount: 45,
              tracking: [{ name: "Lodge", option: "Alpine" }],
            },
          ],
        },
      ],
    };

    expect(sanitizeForJson(payload)).toEqual(payload);
    expect(JSON.stringify(sanitizeForJson(payload))).not.toContain(
      "[TRUNCATED]"
    );
  });

  it("keeps a deeply nested payload whole", () => {
    let deep: unknown = { leaf: "kept" };
    for (let level = 0; level < 20; level += 1) {
      deep = { level, inner: deep };
    }

    expect(JSON.stringify(sanitizeForJson(deep))).toContain("kept");
  });

  it("guards a cycle instead of overflowing the stack", () => {
    const member: Record<string, unknown> = { id: "m1" };
    const group: Record<string, unknown> = { id: "g1", memberships: [member] };
    member.familyGroup = group;

    expect(() => sanitizeForJson(member)).not.toThrow();
    expect(JSON.stringify(sanitizeForJson(member))).toContain("[Circular]");
  });

  it("still applies every redaction rule the log path applies", () => {
    expect(
      sanitizeForJson({
        contacts: [
          {
            firstName: "Jane",
            lastName: "Doe",
            emailAddress: "jane@example.test",
            addresses: [{ addressLine1: "12 Example Street", city: "Tokoroa" }],
          },
        ],
      })
    ).toEqual({
      contacts: [
        {
          firstName: "[REDACTED]",
          lastName: "[REDACTED]",
          emailAddress: "[REDACTED]",
          addresses: [{ addressLine1: "[REDACTED]", city: "[REDACTED]" }],
        },
      ],
    });
  });
});
