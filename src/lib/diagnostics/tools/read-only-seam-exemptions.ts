/**
 * AI Diagnostics — THE CLOSED WORLD OF WHAT DOES NOT READ THROUGH THE SEAM
 * (AID-7b, #2786), and the declaration every `server_owned` entry makes about it.
 *
 * WHY THIS IS ITS OWN MODULE, AND NOT PART OF THE SEAM IT DESCRIBES.
 * `read-only-transaction.ts` holds the application's Prisma client and is therefore
 * `server-only`. `define.ts` is NOT — it carries the spec types the registry and its
 * contract tests read, and pulling a `server-only` module into its import graph would
 * make every one of those importers server-only too. But `define.ts` is exactly where
 * the declaration has to be CHECKED, because that is the one place every entry passes
 * through. So the table lives here, in a module that holds data and no client: the
 * seam imports it, `define.ts` imports it, and neither has to give anything up.
 *
 * WHAT A ROW MEANS. A `server_owned` entry runs on the application's own
 * full-privilege connection, so "read-only" is a property of the code unless the seam
 * makes it a property of the server. A row here says: THIS piece of code reaches the
 * database (or reaches nothing at all) outside that transaction, and here is the
 * structural reason it cannot be moved inside.
 *
 * WHY IT IS DECLARED RATHER THAN INFERRED. The claim "every `server_owned` entry
 * reads through the seam" is not satisfiable, and a contract that overstates itself is
 * worse than one that names its holes: it teaches the next author that the guarantee
 * already covers the case they are about to add. Each entry names the ids it relies on
 * in its own `readOnlySeam` declaration; `define.ts` refuses at definition time to
 * register one that names an id absent from this table, and refuses one that neither
 * threads its own reads nor names anything — so this table, and not a reviewer's
 * memory, is the only sanctioned bypass. `__tests__/read-only-seam-exemptions.test.ts`
 * pins the row set exactly, so a sixth row is a decision somebody made in a diff.
 */

/**
 * One declared reason a `server_owned` read reaches the database — or reaches
 * nothing at all — outside the seam.
 *
 * `module` and `symbol` name the thing that is exempt, not the entry that calls it,
 * because that is what a reviewer has to look at: four of the five rows are SHARED
 * helpers whose behaviour belongs to another feature, and re-homing the entry would
 * not change any of them.
 */
export interface DiagnosticsReadOnlySeamExemption {
  /** Stable id an entry's `readOnlySeam` declaration names. */
  id: string;
  /** Repository-relative module holding the exempt code. */
  module: string;
  /** The exported symbol that reads (or does not read) outside the seam. */
  symbol: string;
  /** Why it structurally cannot run inside the seam. One sentence, reviewed. */
  reason: string;
}

/**
 * What a `server_owned` entry says about its own relationship to the seam. Required
 * on every such spec, so a new entry cannot be written without answering it.
 */
export interface DiagnosticsReadOnlySeamDeclaration {
  /**
   * Does this entry run its OWN database reads inside
   * `withBoundedReadOnlyTransaction`?
   *
   * `false` is not a weaker answer than `true` — it is the honest one for an entry
   * whose every read belongs to an exempt collaborator. What is refused is an entry
   * that says `false` and names nothing, because that entry is claiming to reach the
   * database in some third way nobody has reviewed.
   */
  threadsOwnReads: boolean;
  /**
   * The exemption ids this entry relies on. Omitted — never `[]` — when it relies on
   * none, so "declared nothing" and "declared an empty list" cannot be confused.
   */
  exemptions?: readonly string[];
}

/**
 * THE ROWS. Each is a structural fact rather than a preference.
 *
 * The AID-7 plan expected four. The fifth exists because the definition-time check
 * this table now backs FOUND it: the readiness entry reads the club's module flags on
 * the global client before it ever reaches its own evidence, and no row named that.
 * It is the exact failure the declaration was built to catch, caught on the first
 * entry that was made to answer for itself.
 */
export const READ_ONLY_SEAM_EXEMPTIONS: readonly DiagnosticsReadOnlySeamExemption[] =
  [
    {
      id: "readiness-own-pool",
      module: "src/lib/ai-diagnostics-config.ts",
      symbol: "getDiagnosticsReadiness",
      reason:
        "The readiness verdict is ABOUT the diagnostics role's own connection and opens that role's own pool to probe it, so it must stay answerable in exactly the case where the application database path is the blocker; wrapping it in a transaction on the application connection would make the fault it reports the reason it cannot report.",
    },
    {
      id: "readiness-module-flags-fault-tolerant",
      module: "src/lib/module-settings.ts",
      symbol: "loadEffectiveModuleFlags",
      reason:
        "The readiness entry needs the club's module flags to say whether diagnostics is switched on, and it deliberately calls the fault-TOLERANT loader rather than the strict one a normal evidence caller must use, because a readiness check that cannot answer when the database is unreachable has failed at the one moment it exists for; the seam would convert that same fault into a rejection, and the row still reports the database fault itself through database_role_state and blocker_codes.",
    },
    {
      id: "deployment-no-database",
      module: "src/lib/diagnostics/tools/packs/support-evidence.ts",
      symbol: "readDiagnosticsDeploymentEvidence",
      reason:
        "It reads the image, the disk and three environment variables and touches no database at all, so a transaction would add a pool connection and a failure mode to a read that has neither.",
    },
    {
      id: "usage-summary-no-tx-client",
      module: "src/lib/ai-diagnostics-usage.ts",
      symbol: "getDiagnosticsUsageSummary",
      reason:
        "It is the admin usage panel's own shared calculation, reads the global client and accepts no transaction client; giving it one is a change to a non-diagnostics surface, so the entry runs it before opening the seam and threads only its own three reads.",
    },
    {
      id: "cron-runs-own-budget",
      module: "src/lib/admin-cron-runs.ts",
      symbol: "getCronRunsForAdminHealth",
      reason:
        "It is shared with Admin > Health and enforces its own caller-supplied deadline, which the job-health entry deliberately sets below the executor's race; a transaction-scoped statement timeout would collide with that budget and change which of the two refuses first.",
    },
  ];

/** Every declared exemption id. The list a spec's declaration is checked against. */
export const READ_ONLY_SEAM_EXEMPTION_IDS: readonly string[] =
  READ_ONLY_SEAM_EXEMPTIONS.map((exemption) => exemption.id);

/** Is this a declared exemption? The only sanctioned way to bypass the seam. */
export function isReadOnlySeamExemptionId(id: string): boolean {
  return READ_ONLY_SEAM_EXEMPTION_IDS.includes(id);
}
