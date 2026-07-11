import { createHmac, randomInt, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { hashActionToken, issueActionToken } from "./action-tokens";
import { prisma } from "./prisma";
import { getAuthSecret } from "./runtime-config";

// Lobby display device auth (fork issue #27, ADR-001): a deliberately
// weakest-privileged, sessionless credential. checkDisplayAuth() resolves
// tokenHash → device → lodgeId and nothing else — it never maps to a Member
// and shares no code path with checkLodgeAuth/KioskTier, so the display token
// can never inherit a kiosk capability by accident.

export const DISPLAY_TOKEN_COOKIE = "tac_lodge_display_token";
export const DISPLAY_PAIRING_COOKIE = "tac_lodge_display_pairing";
export const DISPLAY_TOKEN_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
export const PAIRING_CODE_TTL_SECONDS = 15 * 60;
export const PAIRING_CODE_LENGTH = 6;

// Unambiguous on a TV across the room: no 0/O, 1/I.
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const PAIRING_CODE_PATTERN = new RegExp(
  `^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`
);

function getDisplaySecret(): string {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error(
      "AUTH_SECRET or NEXTAUTH_SECRET is required for lobby display pairing"
    );
  }
  return secret;
}

export function isPairingCodeFormat(code: string): boolean {
  return PAIRING_CODE_PATTERN.test(code);
}

export function normalisePairingCode(code: string): string {
  return code.trim().toUpperCase();
}

export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

interface PairingBlobPayload {
  code: string;
  exp: number; // unix seconds
}

function signPart(payloadPart: string): string {
  return createHmac("sha256", getDisplaySecret())
    .update(`lodge-display-pairing:${payloadPart}`)
    .digest("base64url");
}

/**
 * Encodes the pairing blob the display device holds while waiting for an
 * admin to bind its code (ADR-001 §2): tamper-proof carrier for the code and
 * expiry, so the anonymous pairing-start endpoint persists nothing.
 */
export function encodePairingBlob(payload: PairingBlobPayload): string {
  const part = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${part}.${signPart(part)}`;
}

export function decodePairingBlob(raw: string): PairingBlobPayload | null {
  const [part, signature] = raw.split(".");
  if (!part || !signature) return null;

  const expected = Buffer.from(signPart(part), "utf8");
  const presented = Buffer.from(signature, "utf8");
  if (
    expected.length !== presented.length ||
    !timingSafeEqual(expected, presented)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8")
    ) as Partial<PairingBlobPayload>;
    if (
      typeof payload.code !== "string" ||
      !isPairingCodeFormat(payload.code) ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return { code: payload.code, exp: payload.exp };
  } catch {
    return null;
  }
}

/**
 * Admin bind step (ADR-001 §2.2): persist the code the admin read off the TV
 * onto the device record. The only server-side persistence in the pairing
 * flow — anonymous requests never write.
 */
export async function confirmDevicePairing(
  deviceId: string,
  enteredCode: string
): Promise<
  | { ok: true; expiresAt: Date }
  | { ok: false; error: "invalid-code" | "not-found" | "revoked" }
> {
  const code = normalisePairingCode(enteredCode);
  if (!isPairingCodeFormat(code)) {
    return { ok: false, error: "invalid-code" };
  }

  const device = await prisma.lodgeDisplayDevice.findUnique({
    where: { id: deviceId },
    select: { id: true, revokedAt: true },
  });
  if (!device) return { ok: false, error: "not-found" };
  if (device.revokedAt) return { ok: false, error: "revoked" };

  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000);
  await prisma.lodgeDisplayDevice.update({
    where: { id: deviceId },
    data: { pairingCode: code, pairingCodeExpiresAt: expiresAt },
  });
  return { ok: true, expiresAt };
}

export interface ClaimedDisplayToken {
  token: string;
  device: { id: string; lodgeId: string; name: string };
}

/**
 * Device claim step (ADR-001 §2.3): the display presents its signed blob;
 * if an admin has bound that exact code to a device, issue the long-lived
 * display token (hash at rest), clearing the pairing fields (single-use).
 * A successful claim on a previously paired device REPLACES tokenHash —
 * the device-swap story; the old token dies immediately.
 */
export async function claimDisplayToken(
  code: string
): Promise<ClaimedDisplayToken | null> {
  const normalised = normalisePairingCode(code);
  if (!isPairingCodeFormat(normalised)) return null;

  const device = await prisma.lodgeDisplayDevice.findFirst({
    where: {
      pairingCode: normalised,
      pairingCodeExpiresAt: { gt: new Date() },
      revokedAt: null,
    },
    select: { id: true, lodgeId: true, name: true },
  });
  if (!device) return null;

  const { token, tokenHash } = issueActionToken();
  await prisma.lodgeDisplayDevice.update({
    where: { id: device.id },
    data: {
      tokenHash,
      pairingCode: null,
      pairingCodeExpiresAt: null,
    },
  });

  return { token, device };
}

export interface DisplayAuthResult {
  device: {
    id: string;
    lodgeId: string;
    name: string;
    templateId: string | null;
    regionConfig: unknown;
  };
}

/**
 * The display-surface guard. Authorises ONLY the display page shell, the
 * display-state API, and the heartbeat — resolved purely from the hashed
 * token to its device and the device's lodge FK. Rejections never update
 * lastSeenAt (issue #27 AC6).
 */
export async function checkDisplayAuth(
  request: NextRequest
): Promise<DisplayAuthResult | null> {
  const raw = request.cookies.get(DISPLAY_TOKEN_COOKIE)?.value;
  if (!raw || raw.trim().length === 0) return null;

  const device = await prisma.lodgeDisplayDevice.findUnique({
    where: { tokenHash: hashActionToken(raw.trim()) },
    select: {
      id: true,
      lodgeId: true,
      name: true,
      templateId: true,
      regionConfig: true,
      revokedAt: true,
      lodge: { select: { active: true } },
    },
  });

  if (!device || device.revokedAt || !device.lodge.active) return null;

  return {
    device: {
      id: device.id,
      lodgeId: device.lodgeId,
      name: device.name,
      templateId: device.templateId,
      regionConfig: device.regionConfig,
    },
  };
}

/** Heartbeat bookkeeping: only ever called after checkDisplayAuth passes. */
export async function markDisplaySeen(deviceId: string): Promise<void> {
  await prisma.lodgeDisplayDevice.update({
    where: { id: deviceId },
    data: { lastSeenAt: new Date() },
  });
}
