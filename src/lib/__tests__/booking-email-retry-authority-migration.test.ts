import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION =
  "20260801170000_add_email_retry_booking_authority_context";

function repoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("booking-email retry authority migration (#2362)", () => {
  it("adds only nullable, no-backfill EmailLog provenance columns", () => {
    const sql = repoFile(`prisma/migrations/${MIGRATION}/migration.sql`);
    const statements = sql.replace(/^--.*$/gm, "");

    expect(sql).toContain('ALTER TABLE "EmailLog"');
    expect(sql).toContain('ADD COLUMN "bookingRecipientMemberId" TEXT');
    expect(sql).toContain(
      'ADD COLUMN "bookingBodyOverrideApplied" BOOLEAN',
    );
    expect(sql).toContain('ADD COLUMN "bookingDetailLinkIncluded" BOOLEAN');
    expect(statements).not.toMatch(/\bNOT\s+NULL\b/i);
    expect(statements).not.toMatch(/\bDEFAULT\b/i);
    expect(statements).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b/i);
    expect(statements).not.toMatch(/\b(?:DROP|RENAME)\b/i);
  });

  it("keeps the Prisma model nullable so old-colour rows remain representable", () => {
    const schema = repoFile("prisma/schema.prisma");
    const emailLog = schema.match(/model EmailLog \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(emailLog).toMatch(/bookingRecipientMemberId\s+String\?/);
    expect(emailLog).toMatch(/bookingBodyOverrideApplied\s+Boolean\?/);
    expect(emailLog).toMatch(/bookingDetailLinkIncluded\s+Boolean\?/);
  });

  it("records the no-backfill, fail-closed drain contract in the safety ledger", () => {
    const ledger = repoFile("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv");
    const row = ledger
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${MIGRATION}\t`));

    expect(row).toBeDefined();
    expect(row).toContain("NO backfill");
    expect(row).toContain("fail-closed");
    expect(row).toContain("brief ACCESS EXCLUSIVE lock");
    expect(row).toContain("advisory-lock key");
  });
});
