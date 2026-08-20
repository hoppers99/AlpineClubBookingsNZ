import { hashActionToken, isActionTokenFormat, issueActionToken } from "@/lib/action-tokens";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The per-lodge QR bearer token (#2780).
 *
 * WHAT THIS TOKEN IS. It is printed on a sign inside a lodge and it opens one
 * thing: a form that submits a maintenance report for THAT lodge. It is not a
 * session, it is not tied to a person, and holding it grants nothing else — no
 * account data is readable or writable through any route that accepts it. That
 * is the owner's decision 5 on #2780, and it is a property of the ROUTES rather
 * than of this module, so read `/api/maintenance-reports/[token]` alongside it.
 *
 * HOW IT IS STORED. Hashed, exactly like every other bearer token in this
 * schema (`docs/TOKEN_HASHING.md`): `issueActionToken()` mints 256 bits from
 * `randomBytes(32)` and only the SHA-256 hex of it is persisted. A database
 * dump, a backup, or an operator with SELECT therefore cannot reconstruct a
 * working sign. The raw value is returned exactly once — to the admin who minted
 * or rotated it, on the page that shows the sign — and never again.
 *
 * ROTATION REPLACES IN PLACE, and that is deliberate. `lodgeId` is unique, so a
 * lodge has at most one live token; rotating overwrites `tokenHash`, and the
 * previous value stops working in the same transaction. There is NO grace
 * window, because the reason an admin presses Rotate is that the old sign has
 * leaked or walked out of the building — a grace window would keep exactly the
 * credential they are trying to kill alive. The cost is that the sign has to be
 * reprinted, which is the intended trade.
 *
 * WHY LOOKUP CANNOT ENUMERATE. `resolveLodgeForMaintenanceToken` rejects
 * anything that is not 64 hex characters BEFORE touching the database, then does
 * a single unique lookup on the hash. Every failure — bad shape, no such hash,
 * token deactivated, lodge deactivated, module off, setting off — returns the
 * same `null`, and the routes turn every `null` into the same generic 404. So a
 * caller cannot tell "wrong token" from "right token, feature off", and there is
 * no timing branch worth measuring: the shape check is constant work and the
 * lookup is one indexed equality either way.
 */

export type MaintenanceTokenLodge = {
  lodgeId: string;
  lodgeName: string;
  tokenId: string;
};

/**
 * Resolve a raw token to its lodge, or null.
 *
 * NULL IS THE ONLY FAILURE VALUE ON PURPOSE. Callers must not distinguish the
 * reasons, and must not log the raw token. The shared redaction layer strips the
 * `/lodge-maintenance/<token>` path segment from every log line and Sentry event
 * (`src/lib/redact-sensitive-json.ts`), the same way it strips `/pay/<token>`
 * and the other token-bearing paths in `docs/SECURITY.md`.
 */
export async function resolveLodgeForMaintenanceToken(
  rawToken: string,
): Promise<MaintenanceTokenLodge | null> {
  // Shape first. This is what keeps a malformed or oversized path segment from
  // reaching the database at all, and it costs the same for every caller.
  if (!isActionTokenFormat(rawToken)) {
    return null;
  }

  try {
    const record = await prisma.lodgeMaintenanceReportToken.findUnique({
      where: { tokenHash: hashActionToken(rawToken.trim()) },
      select: {
        id: true,
        active: true,
        lodge: { select: { id: true, name: true, active: true } },
      },
    });

    if (!record || !record.active || !record.lodge.active) {
      return null;
    }

    return {
      lodgeId: record.lodge.id,
      lodgeName: record.lodge.name,
      tokenId: record.id,
    };
  } catch (err) {
    // FAIL CLOSED. A database fault must refuse the anonymous door rather than
    // open it; the member path is unaffected because it never comes through
    // here. The token itself is never in `err`, because it is never passed to
    // the query as anything but a hash.
    logger.error({ err }, "Failed to resolve maintenance report token");
    return null;
  }
}

/**
 * Record that a token was used. Best-effort and deliberately outside the submit
 * transaction: `lastUsedAt` is an operator convenience ("is this sign still in
 * use?"), and failing to write it must never fail a submitted report.
 */
export async function touchMaintenanceTokenLastUsed(tokenId: string): Promise<void> {
  try {
    await prisma.lodgeMaintenanceReportToken.update({
      where: { id: tokenId },
      data: { lastUsedAt: new Date() },
    });
  } catch (err) {
    logger.warn({ err, tokenId }, "Failed to record maintenance token use");
  }
}

export type MintedMaintenanceToken = {
  /** Shown to the minting admin ONCE. Never persisted, never logged. */
  token: string;
  rotated: boolean;
};

/**
 * Mint a lodge's first token, or rotate an existing one. Idempotent in neither
 * direction on purpose — every call produces a fresh secret, because the button
 * that calls it is "Create/Regenerate the sign".
 */
export async function mintLodgeMaintenanceToken(
  lodgeId: string,
  actingMemberId: string,
): Promise<MintedMaintenanceToken> {
  const { token, tokenHash } = issueActionToken();
  const now = new Date();

  const existing = await prisma.lodgeMaintenanceReportToken.findUnique({
    where: { lodgeId },
    select: { id: true },
  });

  if (existing) {
    await prisma.lodgeMaintenanceReportToken.update({
      where: { lodgeId },
      data: {
        tokenHash,
        active: true,
        rotatedAt: now,
        rotatedById: actingMemberId,
        // Cleared with the secret it described: a lastUsedAt inherited from the
        // retired token would tell an operator the NEW sign had been scanned.
        lastUsedAt: null,
      },
    });
    return { token, rotated: true };
  }

  await prisma.lodgeMaintenanceReportToken.create({
    data: {
      lodgeId,
      tokenHash,
      createdById: actingMemberId,
    },
  });
  return { token, rotated: false };
}

/**
 * Turn one lodge's sign off (or back on) without minting a new secret.
 *
 * Re-enabling restores the SAME token, so this is a pause rather than a
 * revocation — which is why the admin surface offers Rotate beside it and says
 * which one kills a leaked sign.
 */
export async function setLodgeMaintenanceTokenActive(
  lodgeId: string,
  active: boolean,
): Promise<boolean> {
  const result = await prisma.lodgeMaintenanceReportToken.updateMany({
    where: { lodgeId },
    data: { active },
  });
  return result.count > 0;
}

/** Admin-surface metadata. Deliberately carries no hash and no raw token. */
export async function getLodgeMaintenanceTokenStatus(lodgeId: string) {
  const record = await prisma.lodgeMaintenanceReportToken.findUnique({
    where: { lodgeId },
    select: {
      active: true,
      createdAt: true,
      rotatedAt: true,
      lastUsedAt: true,
    },
  });
  return record ?? null;
}

/**
 * Build the public sign URL for a freshly minted token.
 *
 * Takes the raw token as an argument rather than reading one, because there is
 * nowhere to read one FROM — that is the point of hash-at-rest. A caller that
 * cannot produce a raw token cannot produce a URL, which is what stops a later
 * "just show me the link again" feature being written by accident.
 */
export function buildMaintenanceReportSignUrl(baseUrl: string, rawToken: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/lodge-maintenance/${rawToken}`;
}
