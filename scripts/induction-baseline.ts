#!/usr/bin/env npx tsx
/**
 * Dry-run-first trusted legacy induction baseline.
 *
 * This script reads and writes only the configured PostgreSQL database. It
 * never calls Stripe, Xero, SES, Sentry or another external provider, and it
 * never prints DATABASE_URL or database credentials.
 */
import "dotenv/config";
import process from "node:process";
import {
  assertDatabaseTargetConfirmation,
  buildBlockedInductionBaselineResult,
  formatInductionBaselineOutput,
  parseInductionBaselineArgs,
  parseSafeDatabaseTarget,
} from "../src/lib/induction-baseline-cli";

function printUsage() {
  console.log(`Usage:
  npm run induction:baseline -- \\
    --actor-member-id <member-id> \\
    --baseline-date <YYYY-MM-DD> \\
    --provenance-note "<committee minute / legacy register source>"

  npm run induction:baseline -- \\
    --apply \\
    --actor-member-id <member-id> \\
    --baseline-date <YYYY-MM-DD> \\
    --provenance-note "<committee minute / legacy register source>" \\
    --confirm-club-name "<exact effective club name>" \\
    --confirm-db-host "<exact parsed host[:port] from the dry run>" \\
    --confirm-db-name "<exact parsed database name from the dry run>"

Options:
  --dry-run                 Explicit dry run (the default). Never writes.
  --apply                   Apply the reported baseline atomically.
  --actor-member-id <id>    Active, login-enabled Full Admin actor.
  --baseline-date <date>    Trusted historical NZ date-only value (YYYY-MM-DD).
  --provenance-note <note>  Stable source note stored on every created row.
  --confirm-club-name <name>
                            Exact effective DB-first club name (apply only).
  --confirm-db-host <host>  Exact parsed DATABASE_URL host[:port] (apply only).
  --confirm-db-name <name>  Exact parsed DATABASE_URL database name (apply only).
  --json                    Emit safe machine-readable JSON after the report.
  --help, -h                Show this help.

DATABASE_URL is read but is never printed. The report exposes only its parsed
host[:port] and database name for the apply confirmation.
`);
}

async function main() {
  const args = parseInductionBaselineArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const databaseTarget = parseSafeDatabaseTarget(process.env.DATABASE_URL);
  assertDatabaseTargetConfirmation({
    apply: args.apply,
    target: databaseTarget,
    confirmHost: args.confirmDatabaseHost,
    confirmDatabaseName: args.confirmDatabaseName,
  });

  const [{ prisma }, baseline] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/induction-baseline"),
  ]);

  try {
    const report = await baseline.runInductionBaseline({
      actorMemberId: args.actorMemberId,
      baselineDate: args.baselineDate,
      provenanceNote: args.provenanceNote,
      apply: args.apply,
      confirmClubName: args.confirmClubName,
    });
    console.log(
      formatInductionBaselineOutput(report, databaseTarget, args.json),
    );
  } catch (error) {
    if (error instanceof baseline.InductionBaselineBlockedError) {
      const blocked = buildBlockedInductionBaselineResult(
        error.report,
        databaseTarget,
        args.json,
      );
      console.log(blocked.output);
      process.exitCode = blocked.exitCode;
    }
    throw error;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Unknown trusted induction baseline error",
  );
  process.exitCode = 1;
});
