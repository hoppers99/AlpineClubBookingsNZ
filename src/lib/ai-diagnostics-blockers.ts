/**
 * AI Diagnostics readiness — THE CLOSED, ORDERED BLOCKER CATALOGUE (#2803).
 *
 * `getDiagnosticsReadiness` (`ai-diagnostics-config.ts`) emits these codes, and the
 * `diagnostics.readiness` tool (`diagnostics/tools/packs/support-system.ts`) hands
 * the model both the codes and the sentences below. They live here, in a module with
 * NO imports, for two reasons:
 *
 *  - `ai-diagnostics-config.ts` reaches Prisma, the encrypted credential store and
 *    the diagnostics role's own `pg` pool. A catalogue is data; nothing that wants
 *    to read a code's meaning should have to drag that graph in, and a test that
 *    doubles the readiness aggregate should not have to choose between doubling the
 *    catalogue too and evaluating the real module.
 *  - The sentence and the code must ship together. A code with no sentence is a
 *    token the model has to guess at, and the guess is where a wrong operator
 *    instruction comes from — `module_off` said "turn it on" for two releases in a
 *    case where it was already on (#2803). `DIAGNOSTICS_BLOCKER_DESCRIPTIONS` is a
 *    total `Record`, so a code added without one is a compile error.
 *
 * ORDER IS PRIORITY, and it is the order the aggregate emits in: the first code
 * present is the primary problem and the rest are also true. `resolve_error` is last
 * because it is never emitted beside another code — it means the aggregate could not
 * establish any of them.
 */

/**
 * Every readiness blocker code, in the PRIORITY ORDER an operator should act on
 * them. There is deliberately no `none` code: an empty list IS "nothing is
 * blocking", and a code meaning "no code" would let a caller treat the healthy case
 * as a finding.
 */
export const DIAGNOSTICS_BLOCKER_CODES = [
  /**
   * The club's module settings could not be READ (#2803). The distinction from
   * `module_off` is the whole point of this code: it is not evidence that AI
   * Diagnostics is switched off, it is evidence that nothing is known about
   * whether it is.
   */
  "module_flags_unreadable",
  "module_off",
  "credential_not_configured",
  "credential_needs_reentry",
  "budget_not_set",
  /** `AI_DIAGNOSTICS_DATABASE_URL` is not set (AID-5, #2374). */
  "database_not_configured",
  /** The role is safe but one or more release-declared SELECT grants are absent. */
  "database_grants_missing",
  /**
   * The credential is set but is not a usable least-privilege role: malformed,
   * pointing at the application's own role, unreachable, or the server reports it
   * is not SELECT-only. Deliberately ONE blocker for all four — every one of them
   * is "an operator must fix the diagnostics role", and the distinct
   * `databaseState` says which.
   */
  "database_role_unsafe",
  "resolve_error",
] as const;

/** One readiness blocker code. Closed union; never a free-text reason. */
export type DiagnosticsBlocker = (typeof DIAGNOSTICS_BLOCKER_CODES)[number];

/**
 * THE EXACT MEANING OF EACH CODE, as the model is given it.
 *
 * Server-owned text, never operator or model input. Each sentence says what the
 * code establishes and — where the two could be confused — what it does NOT
 * establish. A test pins that every code has one and that every one reaches the
 * tool description, so a code can never ship without its sentence.
 */
export const DIAGNOSTICS_BLOCKER_DESCRIPTIONS: Record<
  DiagnosticsBlocker,
  string
> = {
  module_flags_unreadable:
    "the club's module settings could not be read, so whether AI Diagnostics is switched on is UNKNOWN. This is NOT evidence that the module is off and must never be reported as though it were: do not tell anyone to switch the module on, because it may already be on. moduleEnabled is null on this row for the same reason. Report it as a fault to investigate — a transient database timeout on that one query, or a deployment window where the running code expects a settings column the database does not have yet.",
  module_off:
    "the club's module settings were read successfully and AI Diagnostics is switched OFF in Admin > Modules. This is a genuine setting, not a failure to read one.",
  credential_not_configured:
    "no dedicated Anthropic API key is stored for diagnostics. A page-help key does not count and is never used.",
  credential_needs_reentry:
    "a dedicated key IS stored but no longer decrypts, which happens after the application's auth secret is rotated. It must be entered again.",
  budget_not_set:
    "the monthly diagnostics budget is zero or negative, so no paid call is authorised. Enabling the module alone authorises no spend.",
  database_not_configured:
    "the dedicated read-only database credential AI_DIAGNOSTICS_DATABASE_URL is not set. Nothing was contacted.",
  database_grants_missing:
    "the read-only diagnostics role is safe but is missing at least one SELECT grant this release declares, usually because a release added a grant and provisioning has not been re-run.",
  database_role_unsafe:
    "the read-only diagnostics role is set but not usable as a least-privilege role — malformed connection string, the application's own role, unreachable, or the server reports it is not SELECT-only. databaseRoleState says which of those it is.",
  resolve_error:
    "readiness could not be resolved at all: the credential state, the budget or the database role check failed. Nothing on the row is established, and it is reported as not ready because a surface that cannot prove it is configured must not spend.",
};
