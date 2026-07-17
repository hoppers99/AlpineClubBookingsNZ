import type { AgeTier } from "@prisma/client";
import { EMAIL_MESSAGE_SETTINGS_ID } from "@/lib/email-message-settings";
import { prisma } from "@/lib/prisma";

/**
 * DB write path for the setup wizard (`scripts/setup.ts runWizard`, C8 #1987).
 *
 * Under the DB-first configuration model (epic #1943) the club's configuration
 * lives in the database, not in `config/club.json`. The interactive wizard used
 * to write that file; it now writes the same settings rows the admin editors
 * write, reusing their field mappings and create-only/tier-keyed upsert shapes:
 *
 *  - identity name / short name       -> ClubIdentitySettings (id="default")
 *    (mirrors src/app/api/admin/club-identity/route.ts + prisma/seed.ts)
 *  - club/booking name, from-name,    -> EmailMessageSetting (id="default")
 *    support/contact email, publicUrl    (mirrors src/app/api/admin/email-settings/route.ts)
 *  - total bunk/bed capacity          -> LodgeSettings (id="default").capacity
 *    (mirrors the admin capacity editor's LodgeSettings write)
 *  - age tiers (label/ages/subscription) -> AgeTierSetting, keyed by the unique
 *    `tier` enum (mirrors src/app/api/admin/age-tier-settings/route.ts and the
 *    seed's create-if-missing loop). Per-tier nightly RATES are NOT stored here
 *    — they live in the seasons/rates tables and are configured at /admin/seasons.
 *
 * The wizard runs as a CLI with no admin session, so `updatedByMemberId` is set
 * to null on the writes it owns (every such column is nullable). Writes are
 * idempotent upserts, so a re-run is safe. This module deliberately does NOT
 * import "server-only" (unlike club-identity-settings.ts) so the tsx CLI can
 * import it, and it takes the Prisma client as a parameter so the write logic is
 * unit-testable with a mocked client (no interactive readline involved).
 */

const CLUB_IDENTITY_SETTINGS_ID = "default";
const LODGE_SETTINGS_ID = "default";

export interface WizardAgeTier {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  sortOrder: number;
}

export interface WizardConfigValues {
  name: string;
  shortName: string | null;
  supportEmail: string;
  contactEmail: string;
  publicUrl: string;
  emailFromName: string;
  capacity: number;
  ageTiers: WizardAgeTier[];
}

/** Minimal upsert/read delegate shape for one Prisma model. */
interface WizardDelegate {
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  findUnique(args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<Record<string, unknown> | null>;
  count(args?: unknown): Promise<number>;
}

/**
 * The subset of the Prisma client the wizard write path uses. The real client
 * satisfies this structurally; tests pass a mock exposing just these delegates.
 */
export interface WizardDbClient {
  clubIdentitySettings: WizardDelegate;
  emailMessageSetting: WizardDelegate;
  lodgeSettings: WizardDelegate;
  ageTierSetting: WizardDelegate;
}

/** Default to the shared Prisma singleton for the real CLI run. */
function defaultDb(): WizardDbClient {
  return prisma as unknown as WizardDbClient;
}

export interface WizardConfigState {
  hasClubIdentity: boolean;
  hasEmailSettings: boolean;
  hasLodgeCapacity: boolean;
  ageTierCount: number;
  existingClubName: string | null;
}

function trimOptional(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/**
 * Read the current DB configuration state used to gate the wizard's
 * overwrite confirmation. Deliberately does NOT swallow errors: the CLI treats
 * a thrown error (unreachable DB / un-migrated schema) as "cannot reach the
 * database" and prints post-deploy /admin/setup guidance instead of writing.
 */
export async function readWizardConfigState(
  db: WizardDbClient = defaultDb(),
): Promise<WizardConfigState> {
  const [identity, email, lodge, ageTierCount] = await Promise.all([
    db.clubIdentitySettings.findUnique({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      select: { name: true },
    }),
    db.emailMessageSetting.findUnique({
      where: { id: EMAIL_MESSAGE_SETTINGS_ID },
      select: { clubName: true, supportEmail: true },
    }),
    db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
      select: { capacity: true },
    }),
    db.ageTierSetting.count(),
  ]);

  return {
    hasClubIdentity: Boolean(trimOptional(identity?.name)),
    hasEmailSettings: Boolean(
      email && (trimOptional(email.clubName) || trimOptional(email.supportEmail)),
    ),
    hasLodgeCapacity: typeof lodge?.capacity === "number",
    ageTierCount,
    existingClubName:
      trimOptional(identity?.name) ?? trimOptional(email?.clubName),
  };
}

/**
 * Write the wizard-collected values to the DB settings rows. Idempotent
 * upserts, applied in the same field mapping the admin editors use. Existing
 * ClubIdentitySettings fields the wizard does not collect (hutLeaderLabel,
 * facebookUrl) are intentionally left untouched.
 */
export async function applyWizardConfigToDatabase(
  values: WizardConfigValues,
  db: WizardDbClient = defaultDb(),
): Promise<void> {
  await db.clubIdentitySettings.upsert({
    where: { id: CLUB_IDENTITY_SETTINGS_ID },
    update: {
      name: values.name,
      shortName: values.shortName,
      updatedByMemberId: null,
    },
    create: {
      id: CLUB_IDENTITY_SETTINGS_ID,
      name: values.name,
      shortName: values.shortName,
      updatedByMemberId: null,
    },
  });

  const emailData = {
    clubName: values.name,
    bookingsName: `${values.name} - Bookings`,
    emailFromName: values.emailFromName,
    supportEmail: values.supportEmail,
    contactEmail: values.contactEmail,
    publicUrl: values.publicUrl,
    updatedByMemberId: null,
  };
  await db.emailMessageSetting.upsert({
    where: { id: EMAIL_MESSAGE_SETTINGS_ID },
    update: emailData,
    create: { id: EMAIL_MESSAGE_SETTINGS_ID, ...emailData },
  });

  await db.lodgeSettings.upsert({
    where: { id: LODGE_SETTINGS_ID },
    update: { capacity: values.capacity, updatedByMemberId: null },
    create: {
      id: LODGE_SETTINGS_ID,
      capacity: values.capacity,
      updatedByMemberId: null,
    },
  });

  for (const tier of values.ageTiers) {
    const tierData = {
      minAge: tier.minAge,
      maxAge: tier.maxAge,
      label: tier.label,
      subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
      familyGroupRequestCreateMemberAllowed:
        tier.familyGroupRequestCreateMemberAllowed,
      sortOrder: tier.sortOrder,
    };
    await db.ageTierSetting.upsert({
      where: { tier: tier.tier },
      update: tierData,
      create: { tier: tier.tier, ...tierData },
    });
  }
}
