import { prisma } from "@/lib/prisma";
import {
  buildClubThemeCss,
  buildClubThemeAppCss,
  CLUB_THEME_ID,
  DEFAULT_CLUB_THEME_VALUES,
  getContrastWarnings,
  logoImageIdFromUrl,
  normaliseThemeValues,
  resolveLogoFields,
} from "@/lib/club-theme-schema";
import type { ClubThemeUpdateInput } from "@/lib/club-theme-update-schema";

async function ensureClubTheme() {
  return prisma.clubTheme.upsert({
    where: { id: CLUB_THEME_ID },
    create: {
      id: CLUB_THEME_ID,
      ...DEFAULT_CLUB_THEME_VALUES,
    },
    update: {},
  });
}

export async function getClubThemeForAdmin() {
  const theme = await ensureClubTheme();
  const values = normaliseThemeValues(theme);
  return {
    ...values,
    completedAt: theme.completedAt?.toISOString() ?? null,
    contrastWarnings: getContrastWarnings(values),
  };
}

/**
 * The incoming `logoUrl` points at a MediaImage row that no longer exists —
 * typically a stale admin tab saving a logo a newer save already replaced.
 * Surfaces as a 409 rather than dangling the theme or deleting a live blob.
 */
export class MissingLogoImageError extends Error {
  constructor() {
    super("Referenced logo image no longer exists");
    this.name = "MissingLogoImageError";
  }
}

export async function saveClubTheme(input: ClubThemeUpdateInput) {
  const existing = await prisma.clubTheme.findUnique({
    where: { id: CLUB_THEME_ID },
    select: { completedAt: true },
  });
  const completedAt = input.completeSetup
    ? (existing?.completedAt ?? new Date())
    : (existing?.completedAt ?? null);

  // #2187: only the three seed columns are written; the four former brand
  // columns (charcoal/ridge/mist/snow surfaces) are dead to code and left to
  // their DB defaults (P4 drops them).
  // #2322: exclusivity is enforced server-side, not trusted from the client, so
  // a stale wizard cannot re-inline a logo already migrated to URL form.
  const logoFields = resolveLogoFields({
    logoUrl: input.logoUrl,
    logoDataUrl: input.logoDataUrl,
  });

  const data = {
    brandGold: input.brandGold,
    brandDeep: input.brandDeep,
    brandSafety: input.brandSafety,
    headingFontKey: input.headingFontKey,
    bodyFontKey: input.bodyFontKey,
    ...logoFields,
    rawCss: input.rawCss ?? "",
    completedAt,
  };

  // The write and the previous logo blob's cleanup share one transaction so a
  // replaced logo never orphans its MediaImage row (mirrors the member-photo
  // pattern). No external calls inside the transaction.
  //
  // Explicit timings (#2322): config-transfer apply holds this same ClubTheme
  // row for its whole bundle transaction, so Prisma's defaults (2s maxWait / 5s
  // timeout) would surface a routine concurrent import as a 500. The route maps
  // an exhausted wait to a 503 retry-later instead.
  const theme = await prisma.$transaction(
    async (tx) => {
      // FOR UPDATE locks nothing when the row does not exist, so two first-ever
      // saves would not serialise against each other. Materialise the singleton
      // first (a no-op once it exists), then lock it.
      await tx.clubTheme.createMany({
        data: [{ id: CLUB_THEME_ID, ...data }],
        skipDuplicates: true,
      });

      // Lock the theme row and read its CURRENT logo under that lock, so two
      // concurrent saves serialise instead of both deleting the same stale blob
      // and orphaning the other's new one.
      const locked = await tx.$queryRaw<Array<{ logoUrl: string | null }>>`
        SELECT "logoUrl" FROM "ClubTheme" WHERE "id" = ${CLUB_THEME_ID} FOR UPDATE`;
      const previousLogoImageId = logoImageIdFromUrl(locked[0]?.logoUrl ?? null);
      const nextLogoImageId = logoImageIdFromUrl(logoFields.logoUrl);

      // A stale tab can post a logoUrl whose blob a newer save already deleted.
      // Writing it would dangle the theme, and on an A->B->A sequence would also
      // delete a blob that is still referenced. Verify presence under the lock
      // and refuse instead.
      if (nextLogoImageId) {
        const referenced = await tx.mediaImage.findFirst({
          where: { id: nextLogoImageId, kind: { in: ["LOGO", "CONTENT"] } },
          select: { id: true },
        });
        if (!referenced) {
          throw new MissingLogoImageError();
        }
      }

      const saved = await tx.clubTheme.update({
        where: { id: CLUB_THEME_ID },
        data,
      });

      if (previousLogoImageId && previousLogoImageId !== nextLogoImageId) {
        // Scoped to LOGO so this can never take out a CONTENT image: page HTML
        // and the image-library picker may still reference those, and a logo that
        // arrived through config transfer or the legacy data-URI path is not a
        // LOGO row at all.
        await tx.mediaImage.deleteMany({
          where: { id: previousLogoImageId, kind: "LOGO" },
        });
      }

      return saved;
    },
    { maxWait: 10_000, timeout: 15_000 },
  );

  const values = normaliseThemeValues(theme);
  return {
    ...values,
    completedAt: theme.completedAt?.toISOString() ?? null,
    contrastWarnings: getContrastWarnings(values),
  };
}

export async function getWebsiteThemeRenderState() {
  const theme = await prisma.clubTheme
    .findUnique({
      where: { id: CLUB_THEME_ID },
    })
    .catch(() => null);
  const values = normaliseThemeValues(theme ?? DEFAULT_CLUB_THEME_VALUES);

  return {
    values,
    css: buildClubThemeCss(values),
    appCss: buildClubThemeAppCss(values),
    logoUrl: values.logoUrl,
    logoDataUrl: values.logoDataUrl,
    isComplete: Boolean(theme?.completedAt),
  };
}
