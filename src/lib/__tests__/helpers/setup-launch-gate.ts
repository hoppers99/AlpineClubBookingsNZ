/**
 * A healthy `runtime-env` and `auth-secret-strength` for the launch gate (epic
 * #213, C15 fix round on #247).
 *
 * `refuseSiteVisibilityWhileLaunchBlocked` (`@/lib/site-visibility-gate`)
 * widened from checking the environment role alone to checking all three
 * registry `launchGate: "blocks-until-complete"` facts. `buildRuntimeEnvCheck`
 * and `buildAuthSecretStrengthCheck` read `process.env` directly, which in the
 * unit suite is whatever the runner happened to export — none of
 * `DATABASE_URL`, `NEXTAUTH_URL`, `CRON_SECRET`, `SEED_ADMIN_EMAIL`,
 * `SEED_ADMIN_PASSWORD` or a strong `AUTH_SECRET` by default. Every suite that
 * exercises a SUCCESSFUL publish through `saveClubTheme`'s `completeSetup`
 * branch or the dedicated complete-setup route now needs to say so explicitly,
 * exactly as `declareEnvironmentRole` (`./environment-role.ts`) already makes a
 * suite say which installation it is pretending to be.
 *
 * Mirrors `baseEnv` in `setup-readiness.test.ts` for the same five runtime
 * variables and a strong (>= 32 char, non-placeholder) `AUTH_SECRET`, so the
 * two suites' idea of "healthy" cannot drift apart. Uses `vi.stubEnv`, so it is
 * undone by `vi.unstubAllEnvs()` in the caller's own `afterEach` — call it from
 * `beforeEach`, after any `vi.unstubAllEnvs()` the suite already does, the same
 * ordering rule `declareEnvironmentRole` documents.
 */
import { vi } from "vitest";

export function stubHealthyLaunchGateEnv(): void {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/app");
  vi.stubEnv("NEXTAUTH_URL", "https://club.example.org");
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("SEED_ADMIN_EMAIL", "admin@example.org");
  vi.stubEnv("SEED_ADMIN_PASSWORD", "change-me");
  vi.stubEnv("AUTH_SECRET", "a".repeat(48));
}
