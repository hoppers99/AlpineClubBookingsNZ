/**
 * Alpine Central Server (ServerNZ) connection configuration.
 *
 * The ServerNZ API key is a secret and lives ONLY in the encrypted
 * IntegrationCredential store (same mechanism as Stripe/Xero/Google, #2079).
 * The non-secret connection settings (base URL, per-shared-item enabled flags,
 * last-sync timestamps) live in the `ServerNzSettings` singleton — see
 * `servernz-settings.ts`.
 *
 * Exposure contract: the API key is NEVER returned to a client, logged, or put
 * in an audit row. Status surfaces read metadata only (`getServerNzSetupState`).
 */

import { prisma } from "@/lib/prisma";
import {
  getIntegrationCredentialValue,
  setIntegrationCredential,
  deleteIntegrationCredential,
} from "@/lib/integration-credentials";

export const SERVERNZ_PROVIDER = "servernz";

export const SERVERNZ_CREDENTIAL_KEYS = {
  apiKey: "api_key",
} as const;

/** The write-capturable ServerNZ credential keys (setup form + API allowlist). */
export const SERVERNZ_WRITABLE_CREDENTIAL_KEYS = [
  SERVERNZ_CREDENTIAL_KEYS.apiKey,
] as const;

/** The operational ServerNZ API key, or `undefined` when unconfigured. */
export async function getOperationalServerNzApiKey(): Promise<
  string | undefined
> {
  return (
    (await getIntegrationCredentialValue(
      SERVERNZ_PROVIDER,
      SERVERNZ_CREDENTIAL_KEYS.apiKey,
    )) ?? undefined
  );
}

/** Store (or replace) the ServerNZ API key. Encrypted at rest. */
export async function setServerNzApiKey(
  value: string,
  updatedByUserId?: string,
): Promise<void> {
  await setIntegrationCredential({
    provider: SERVERNZ_PROVIDER,
    key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    value,
    updatedByUserId,
  });
}

/** Remove the stored ServerNZ API key (disconnect). */
export async function clearServerNzApiKey(): Promise<void> {
  await deleteIntegrationCredential(
    SERVERNZ_PROVIDER,
    SERVERNZ_CREDENTIAL_KEYS.apiKey,
  );
}

export interface ServerNzSetupState {
  apiKeySet: boolean;
  apiKeyUpdatedAt: string | null;
}

/**
 * Metadata-only setup state for the setup page and module readiness. NEVER
 * returns the key value. A DB error propagates to the caller.
 */
export async function getServerNzSetupState(): Promise<ServerNzSetupState> {
  const row = await prisma.integrationCredential.findFirst({
    where: {
      provider: SERVERNZ_PROVIDER,
      key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    },
    select: { updatedAt: true },
  });
  return {
    apiKeySet: Boolean(row),
    apiKeyUpdatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/** True when a ServerNZ API key is configured (readiness helper, fail-closed). */
export async function isServerNzConfigured(): Promise<boolean> {
  try {
    const state = await getServerNzSetupState();
    return state.apiKeySet;
  } catch {
    return false;
  }
}
