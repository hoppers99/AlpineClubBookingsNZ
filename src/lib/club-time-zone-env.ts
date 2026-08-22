/**
 * The environment's club timezone, as a SEED ONLY (CT-1, #2989).
 *
 * `TZ` / `NEXT_PUBLIC_TZ` were the club timezone before CT-1, so they are what an
 * existing deployment's "current effective timezone" means, and they are the only
 * thing a first boot after the upgrade can copy from. That is the whole of their
 * remaining role: `resolveClubTimeZone` consults the seed only when nothing is
 * persisted, and the boot backfill persists it once so that stops being true. The
 * transitional `APP_TIME_ZONE` constant in `src/config/operational.ts` still
 * derives from the same two variables for the call sites CT-2 to CT-5 have not
 * migrated yet, and `club-time-zone-env-agreement.test.ts` pins the two readings
 * together so they cannot drift apart while both exist. Retired by CT-6 (#2991).
 *
 * WHY THIS IS ITS OWN MODULE rather than sitting beside the validator (#2989
 * review). `club-time-zone.ts` is deliberately free of `server-only` because the
 * admin panel needs its zone list — which puts everything in it on the CLIENT
 * bundle graph. A `process.env` read there is a latent second authority of exactly
 * the kind `INV-CONFIG-002` forbids: Next inlines only `NEXT_PUBLIC_*`, so in a
 * browser the same function would return the BUILD-TIME `NEXT_PUBLIC_TZ`, which
 * can differ from the running server's. Nothing called it client-side, but the
 * only thing standing between that and a real split-brain was nobody having
 * imported it yet.
 *
 * This module is equally NOT marked `server-only`, and that is not an oversight:
 * two of its four callers are the `tsx` entrypoints (`npm run config:self-heal`
 * and `npm run setup`), which a `server-only` import would abort. It is kept off
 * the client graph by the honest means instead — nothing in `src/app` or
 * `src/components` imports it, and `client-server-boundary-census.test.ts`
 * (`INV-OPS-013`) is the guard that keeps it that way.
 */

import { normaliseClubTimeZoneForPreservation } from "@/lib/club-time-zone";

/**
 * The raw environment seed, or `null` when neither variable is set.
 *
 * Read LIVE from `process.env` rather than from a module-level constant, which is
 * not a detail: a constant frozen at import makes a "the database wins over the
 * environment" test unable to tell a real precedence rule from an environment
 * read that never happened.
 */
export function readEnvironmentClubTimeZoneSeed(): string | null {
  return process.env.TZ?.trim() || process.env.NEXT_PUBLIC_TZ?.trim() || null;
}

/**
 * What the environment seed is worth to a writer that must PRESERVE it.
 *
 * Three outcomes, and the middle one is the reason this exists rather than a
 * bare string (#2989 review). A writer that cannot tell "nothing is set" from
 * "something is set that I refuse to record" will substitute the New Zealand
 * default for both — which is correct for the first and silently moves a club's
 * civil time for the second.
 *
 * - `absent`   — neither variable is set. The documented `Pacific/Auckland`
 *                fallback applies; this is the "truly unset legacy install" the
 *                issue names.
 * - `preserved`— the seed canonicalises to a real location. `timeZone` is that
 *                location and is exactly what the deployment has been running on:
 *                record it. `raw` is what the environment actually said, which is
 *                worth logging when the two differ (`GB` → `Europe/London`).
 * - `unusable` — the seed is set but names no place (`UTC`, `Etc/GMT-12`,
 *                `SystemV/EST5`). There is nothing to preserve and every
 *                candidate would be a guess, so a writer must record NOTHING and
 *                let the setup checklist ask the operator. `raw` is what to show
 *                them.
 */
export type EnvironmentClubTimeZoneSeed =
  | { kind: "absent" }
  | { kind: "preserved"; timeZone: string; raw: string }
  | { kind: "unusable"; raw: string };

export function classifyEnvironmentClubTimeZoneSeed(): EnvironmentClubTimeZoneSeed {
  const raw = readEnvironmentClubTimeZoneSeed();
  if (!raw) return { kind: "absent" };
  const timeZone = normaliseClubTimeZoneForPreservation(raw);
  return timeZone ? { kind: "preserved", timeZone, raw } : { kind: "unusable", raw };
}
