import clearStarterFooterAffiliations from "./20260802140000_clear_starter_footer_affiliations";
import clearWaldvogelLodgeAddress from "./20260802110000_clear_waldvogel_lodge_address";
import type { DataMigrationVerification } from "./types";

/**
 * The registry of data-migration verification fixtures (#2418).
 *
 * `src/lib/__tests__/data-migration-verification.realdb.test.ts` executes
 * everything listed here against a real PostgreSQL: it replays every earlier
 * migration, seeds each case's pre-state, runs the real `migration.sql`, and
 * asserts the rows — then re-runs each case against deliberately broken copies
 * of the migration to prove the assertions have teeth.
 *
 * A fixture that is NOT listed here never runs, which is coverage that does not
 * exist. `scripts/check-data-migration-verification.sh` fails on an unregistered
 * fixture for that reason, and fails on a data-rewriting migration that ships no
 * fixture at all.
 *
 * Listed oldest migration first — the runner replays the migration chain once,
 * in order, and advances through it.
 */
export const DATA_MIGRATION_VERIFICATIONS: DataMigrationVerification[] = [
  clearWaldvogelLodgeAddress,
  clearStarterFooterAffiliations,
];
