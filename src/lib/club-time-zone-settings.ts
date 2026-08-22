import "server-only";

/**
 * The canonical, server-owned club-timezone reader (CT-1, #2989; epic #2988).
 *
 * THIS IS THE ONE PLACE that answers "what timezone is this club in?" for
 * business purposes. The answer comes from `ClubTimeSettings` (id="default"); the
 * environment is consulted only when nothing is persisted, and the reader in the
 * browser is never consulted at all. CT-2 builds the `club-time` kernel on top of
 * this function; nothing downstream should re-derive the zone from
 * `process.env`, from `Intl.DateTimeFormat().resolvedOptions().timeZone`, or from
 * the database session. INV-CONFIG-002.
 *
 * WHY IT IS SERVER-OWNED. A viewer in London must see the same club time as a
 * viewer in Ohakune, so the zone cannot come from the machine rendering the page.
 * Server components read it here and pass the resolved identifier down; a client
 * component receives it as a prop and never asks its own host.
 *
 * WHY IT NEVER THROWS. Every read is defensive: an absent row, an unreachable
 * database (unit tests run with a deliberately unreachable `DATABASE_URL`) and a
 * missing Prisma delegate all resolve to "not persisted", which falls through to
 * the environment seed and then to the documented default. A configuration reader
 * that can throw turns a database blip into a blank page.
 *
 * NO CACHE, DELIBERATELY. This is one primary-key read of a one-row table, and
 * CT-1's callers touch it a handful of times per request. A cache here would need
 * an invalidation contract on every writer, and CT-2 — which is where the hot,
 * per-format call sites arrive — is the change that should choose that contract
 * rather than inherit one guessed at now.
 */

import {
  readEnvironmentClubTimeZoneSeed,
  resolveClubTimeZone,
} from "@/lib/club-time-zone";
import { prisma } from "@/lib/prisma";

/**
 * The `ClubTimeSettings` singleton row id. Its own constant rather than a shared
 * one, exactly as `CLUB_IDENTITY_SETTINGS_ID` is: several models happen to use
 * the value "default" and coupling them through one constant would make a future
 * change to one of them silently a change to all.
 */
export const CLUB_TIME_SETTINGS_ID = "default";

/** The Prisma projection every read of this row uses. */
const CLUB_TIME_SETTINGS_SELECT = {
  timeZone: true,
  updatedByMemberId: true,
  updatedAt: true,
} as const;

export interface PersistedClubTimeSettings {
  timeZone: string;
  updatedByMemberId: string | null;
  updatedAt: Date;
}

/** The minimal delegate shape, so a structural fake can stand in for tests. */
type ClubTimeSettingsDelegate = {
  findUnique: (args: {
    where: { id: string };
    select: typeof CLUB_TIME_SETTINGS_SELECT;
  }) => Promise<PersistedClubTimeSettings | null>;
};

function clubTimeSettingsDelegate(): ClubTimeSettingsDelegate | undefined {
  return (
    prisma as unknown as { clubTimeSettings?: ClubTimeSettingsDelegate }
  ).clubTimeSettings;
}

/**
 * The persisted row, or `null` when it is absent, the database is unreachable, or
 * the delegate does not exist. Never throws — see the module doc.
 */
export async function loadPersistedClubTimeSettings(): Promise<PersistedClubTimeSettings | null> {
  const delegate = clubTimeSettingsDelegate();
  if (!delegate) return null;
  try {
    return await delegate.findUnique({
      where: { id: CLUB_TIME_SETTINGS_ID },
      select: CLUB_TIME_SETTINGS_SELECT,
    });
  } catch {
    return null;
  }
}

/**
 * The club's timezone as a validated IANA identifier. Always answers.
 *
 * Persisted value → environment seed (`TZ` / `NEXT_PUBLIC_TZ`, seed-only, retired
 * by CT-6) → `Pacific/Auckland`. Once the row exists the environment is not
 * consulted, so changing the container's `TZ` cannot change what this returns.
 */
export async function getClubTimeZone(): Promise<string> {
  const persisted = await loadPersistedClubTimeSettings();
  return resolveClubTimeZone(
    persisted?.timeZone ?? null,
    readEnvironmentClubTimeZoneSeed(),
  );
}

/**
 * Where the answer came from, for the surfaces that have to SAY so — the setup
 * readiness step and the maintenance page both have to distinguish "this club has
 * chosen its timezone" from "this is what the environment happens to say until
 * the first boot of the upgraded release persists it".
 */
export type ClubTimeZoneSource = "persisted" | "environment" | "default";

export interface ResolvedClubTimeZone {
  timeZone: string;
  source: ClubTimeZoneSource;
  /** The persisted row, when there is one — for "changed by" / "changed at". */
  persisted: PersistedClubTimeSettings | null;
}

/** {@link getClubTimeZone} plus its provenance. */
export async function resolveClubTimeZoneWithSource(): Promise<ResolvedClubTimeZone> {
  const persisted = await loadPersistedClubTimeSettings();
  const environmentSeed = readEnvironmentClubTimeZoneSeed();
  const timeZone = resolveClubTimeZone(
    persisted?.timeZone ?? null,
    environmentSeed,
  );
  const source: ClubTimeZoneSource =
    persisted && persisted.timeZone && timeZone === persisted.timeZone
      ? "persisted"
      : environmentSeed && timeZone === environmentSeed
        ? "environment"
        : "default";
  return { timeZone, source, persisted };
}
