#!/usr/bin/env npx tsx
/**
 * Operator repair for Stripe per-delta refund credit-note links damaged by the
 * pre-#2901 canonical cleanup (and for the local aftermath of voiding the
 * Xero-side duplicate notes the resulting loop created).
 *
 * LOCAL ledger writes only: it reactivates the wrongly deactivated
 * REFUND_CREDIT_NOTE links until active coverage equals the payment's
 * refunded total exactly, and deactivates local mirrors of notes already
 * VOIDED/DELETED in Xero. It makes ZERO provider calls and never voids or
 * deletes a Xero document — Xero-side duplicates are voided by the operator in
 * Xero first (runbook: docs/xero/ARCHITECTURE.md → "Repairing Stripe
 * refund-note links (#2901)").
 *
 * Dry run by default. SAFE USAGE — review the dry-run report first, keep its
 * output with the change record, then apply:
 *
 *   npx tsx scripts/xero-refund-note-link-repair.ts                # dry run
 *   npx tsx scripts/xero-refund-note-link-repair.ts --payment <id> # scoped dry run
 *   npx tsx scripts/xero-refund-note-link-repair.ts --apply        # repair
 */
import "dotenv/config";
import process from "node:process";
import {
  applyStripeRefundNoteLinkRepairs,
  findStripeRefundNoteLinkRepairs,
  formatStripeRefundNoteLinkRepairReport,
} from "../src/lib/xero-refund-note-link-repair";
import { prisma } from "../src/lib/prisma";

function printUsage() {
  console.log(`Usage:
  npx tsx scripts/xero-refund-note-link-repair.ts                 # dry run (default)
  npx tsx scripts/xero-refund-note-link-repair.ts --dry-run       # explicit dry run
  npx tsx scripts/xero-refund-note-link-repair.ts --payment <id>  # scope to payment id(s) (repeatable)
  npx tsx scripts/xero-refund-note-link-repair.ts --apply         # apply the repairable plans

Options:
  --apply         Apply the repairable plans, each payment in its own
                  transaction. Without it (the default) nothing is written.
  --payment <id>  Restrict to one payment id; repeat for several.
  --json          Emit machine-readable JSON alongside the report.
  --help, -h      Show this help.
`);
}

function parseArgs(argv: string[]) {
  const options = { apply: false, json: false, paymentIds: [] as string[] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--payment") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--payment requires a payment id");
      }
      options.paymentIds.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope =
    args.paymentIds.length > 0 ? { paymentIds: args.paymentIds } : undefined;

  if (!args.apply) {
    const report = await findStripeRefundNoteLinkRepairs(scope);
    console.log("DRY RUN — nothing was written.\n");
    console.log(formatStripeRefundNoteLinkRepairReport(report));
    if (args.json) {
      console.log("\n" + JSON.stringify(report, null, 2));
    }
    return;
  }

  const result = await applyStripeRefundNoteLinkRepairs(scope);
  console.log(formatStripeRefundNoteLinkRepairReport(result.report));
  console.log(
    `\nApplied ${result.appliedPayments} payment(s): reactivated ${result.reactivatedLinks} link(s), deactivated ${result.deactivatedLinks} cancelled-note link(s).`
  );
  for (const skipped of result.skippedPayments) {
    console.log(`Skipped ${skipped.paymentId}: ${skipped.reason}`);
  }
  if (args.json) {
    console.log("\n" + JSON.stringify(result, null, 2));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
