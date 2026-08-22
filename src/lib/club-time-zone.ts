/**
 * The club timezone's shape and validation (CT-1, #2989; epic #2988).
 *
 * ONE IANA IDENTIFIER PER INSTALLATION. The club's civil time is a named zone
 * such as `Pacific/Auckland` — a place, whose DST rules the platform reads from
 * the IANA database. It is never an abbreviation (`NZT`, `NZST`, `EST`), never a
 * fixed offset (`+12:00`, `Etc/GMT-12`), and never the reader's own clock.
 * INV-CONFIG-002.
 *
 * WHY A SHAPE RULE AND NOT `Intl.supportedValuesOf("timeZone")`. Membership of
 * that list was the obvious validator and is the wrong one. Measured on Node
 * 24.15.0 here it holds 418 zones and is NOT canonical across engines: it
 * contains `Asia/Calcutta` and NOT `Asia/Kolkata`, because it is whatever the
 * bundled ICU calls canonical. A different ICU answers the other way round. Both
 * spellings are accepted by `Intl.DateTimeFormat` on every engine, so validating
 * by list membership would let an ICU upgrade turn a perfectly good stored zone
 * into an invalid one. The list is still exactly right for OFFERING choices
 * (`listSelectableClubTimeZones`), and useless for judging a stored value.
 *
 * So the rule is: an IANA identifier SHAPE, then a runtime usability probe, then
 * the same shape rule again on whatever the runtime canonicalised it to.
 * Measured against all 418 zones the shape below matches every one of them, and
 * every zone in that list contains a `/` — which is what makes requiring one
 * reject the whole single-word alias family (`NZ`, `Japan`, `EST`, `UTC`, `GMT`,
 * `Zulu`, `PST8PDT`) in one stroke. Those are not wrong because the platform
 * cannot read them; `Intl` reads `EST` happily, as `America/Panama`. They are
 * wrong because an abbreviation does not name a place, so it carries no promise
 * about which DST rules a club's future bookings will be priced and rostered
 * against.
 *
 * TWO NAMESPACES ARE REJECTED BY NAME, and they are the reason the shape rule
 * alone is not enough. `Etc/GMT-14` and `SystemV/EST5` both satisfy the shape
 * (the hyphen and the digits are legal identifier characters) and both resolve to
 * themselves rather than to a real location. `Etc/*` is the fixed-offset
 * namespace — no DST, reversed sign convention, exactly the "fixed offset in a
 * spelling `Intl` accepts" the issue names — and `SystemV/*` is a legacy
 * posix-rule namespace with frozen DST rules. No club's civil time is either.
 *
 * This module is deliberately free of `server-only` and of every Prisma import:
 * the setup CLI, the boot backfill, the API route and the admin panel all need
 * the same judgement, and a validator that only half the writers can reach is how
 * two of them drift.
 */

/**
 * The generic New Zealand default — used ONLY where no prior effective
 * configuration exists at all. It is a distribution default, not an assumption
 * about which club this is: an install that has been running on another zone
 * keeps that zone (see `clubTimeZoneSelfHealStep`).
 */
export const CLUB_TIME_ZONE_FALLBACK = "Pacific/Auckland";

/** Matches `ClubTimeSettings.timeZone`'s `@db.VarChar(64)`. */
export const CLUB_TIME_ZONE_MAX_LENGTH = 64;

/**
 * An IANA identifier: ASCII segments separated by `/`, at least two of them.
 * Verified against every zone `Intl.supportedValuesOf("timeZone")` reports.
 */
const IANA_IDENTIFIER_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_-]+)+$/;

/** Fixed-offset and legacy-posix namespaces — see the module doc. */
const NON_LOCATION_NAMESPACE = /^(?:etc|systemv)\//i;

function hasIanaIdentifierShape(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= CLUB_TIME_ZONE_MAX_LENGTH &&
    IANA_IDENTIFIER_SHAPE.test(value) &&
    !NON_LOCATION_NAMESPACE.test(value)
  );
}

/**
 * The canonical spelling of a usable named IANA club timezone, or `null`.
 *
 * Trims, then judges the SHAPE of what the caller supplied — so `EST` is refused
 * before the runtime gets a chance to widen it into `America/Panama` — then asks
 * the runtime to resolve it, and judges the resolved identifier by the same rule.
 * The resolved spelling is what comes back, so a deprecated alias
 * (`US/Pacific`) or a case variant (`pacific/auckland`) is stored the way this
 * runtime names the zone rather than the way it was typed.
 */
export function normaliseClubTimeZone(
  value: string | null | undefined,
): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!hasIanaIdentifierShape(candidate)) return null;

  let resolved: string;
  try {
    // Pinned by construction: `timeZone` is the value under test. The locale is
    // irrelevant — nothing here formats anything, the probe exists only to make
    // the runtime accept or reject the zone and report its canonical name.
    resolved = new Intl.DateTimeFormat("en-NZ", {
      timeZone: candidate,
    }).resolvedOptions().timeZone;
  } catch {
    // RangeError: this runtime has no such zone.
    return null;
  }

  return hasIanaIdentifierShape(resolved) ? resolved : null;
}

/** True when `value` is a usable named IANA club timezone. */
export function isValidClubTimeZone(value: string | null | undefined): boolean {
  return normaliseClubTimeZone(value) !== null;
}

/**
 * Resolve the club timezone from the persisted value, with the environment as a
 * SEED-ONLY fallback and `Pacific/Auckland` as the last resort.
 *
 * THE PRECEDENCE IS THE WHOLE POINT (INV-CONFIG-002). A valid persisted value
 * wins outright: once the club has configured its timezone, `TZ` and
 * `NEXT_PUBLIC_TZ` are not a second opinion, and moving the container's clock
 * cannot move the club's civil time. The environment is read ONLY when nothing is
 * persisted — the window between `prisma migrate deploy` and the first boot of
 * the upgraded release, which is exactly the window in which an existing
 * deployment's current effective zone must be preserved unchanged.
 *
 * A persisted value that does not validate is treated as absent rather than
 * trusted, because the only ways to get one there are database surgery and an
 * ICU that no longer knows the zone; in both cases falling through to the
 * environment and then to the documented default keeps the app answering.
 *
 * Pure, so the precedence itself is unit-testable without a database.
 */
export function resolveClubTimeZone(
  persisted: string | null | undefined,
  environmentTimeZone: string | null | undefined,
): string {
  return (
    normaliseClubTimeZone(persisted) ??
    normaliseClubTimeZone(environmentTimeZone) ??
    CLUB_TIME_ZONE_FALLBACK
  );
}

/**
 * The environment's club timezone, as a SEED ONLY.
 *
 * `TZ` / `NEXT_PUBLIC_TZ` were the club timezone before CT-1, so they are what an
 * existing deployment's "current effective timezone" means, and they are the only
 * thing a first boot after the upgrade can copy from. That is the whole of their
 * remaining role: `resolveClubTimeZone` consults this only when nothing is
 * persisted, and `clubTimeZoneSelfHealStep` persists it once so that stops being
 * true. The transitional `APP_TIME_ZONE` constant in `src/config/operational.ts`
 * still derives from the same two variables for the call sites CT-2/CT-4 have not
 * migrated yet, and `club-time-zone-env-agreement.test.ts` pins the two readings
 * together so they cannot drift apart while both exist. Retired by CT-6.
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
 * Every named zone this runtime can offer, for a selector's options.
 *
 * `Intl.supportedValuesOf` is the right source HERE and the wrong one for
 * validation (module doc). Filtered through the same shape rule so the two can
 * never disagree about a value the operator is shown, and sorted so the list
 * reads the same on every runtime. `CLUB_TIME_ZONE_FALLBACK` is unioned in so
 * the documented default is always offerable even on a runtime whose list omits
 * it.
 */
export function listSelectableClubTimeZones(): string[] {
  const offered = new Set<string>([CLUB_TIME_ZONE_FALLBACK]);
  try {
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      if (hasIanaIdentifierShape(zone)) offered.add(zone);
    }
  } catch {
    // A runtime without supportedValuesOf still offers the documented default.
  }
  return [...offered].sort((left, right) => left.localeCompare(right, "en"));
}
