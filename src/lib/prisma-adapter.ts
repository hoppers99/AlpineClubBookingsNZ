import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

const DEFAULT_CONNECTION_TIMEOUT_MILLIS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MILLIS = 300_000;

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readConnectionOption(databaseUrl: string, key: string): string | null {
  try {
    return new URL(databaseUrl).searchParams.get(key);
  } catch {
    return null;
  }
}

/**
 * How long pg will wait for a connection — INCLUDING time spent queued behind
 * busy ones, which is the part that matters and the part that is easy to miss.
 *
 * Exported since #2804 because it is the FIRST bound on any pooled read, and the
 * diagnostics bound ladder was written without it. That ladder asked Prisma to
 * wait 20 s for a connection while this resolved to 10 s in production, so pg
 * rejected first — with a bare `Error` carrying no code — and the longer wait
 * simply never happened. A bound nothing can exceed has to be visible to the
 * things that must stay under it.
 */
export function resolvePoolAcquisitionTimeoutMillis(databaseUrl: string): number {
  return resolveTimeoutMillis(databaseUrl);
}

function resolveTimeoutMillis(databaseUrl: string): number {
  const connectTimeoutSeconds = parsePositiveInteger(
    readConnectionOption(databaseUrl, "connect_timeout")
  );
  const poolTimeoutSeconds = parsePositiveInteger(
    readConnectionOption(databaseUrl, "pool_timeout")
  );
  const timeoutSeconds = connectTimeoutSeconds ?? poolTimeoutSeconds;

  return timeoutSeconds
    ? timeoutSeconds * 1_000
    : DEFAULT_CONNECTION_TIMEOUT_MILLIS;
}

function requireDatabaseUrl(envKey = "DATABASE_URL"): string {
  const databaseUrl = process.env[envKey]?.trim();
  if (!databaseUrl) {
    throw new Error(`${envKey} must be set before creating PrismaClient`);
  }
  return databaseUrl;
}

export function createPrismaPgAdapter(databaseUrl = requireDatabaseUrl()) {
  return new PrismaPg({
    connectionString: databaseUrl,
    max: parsePositiveInteger(readConnectionOption(databaseUrl, "connection_limit")),
    connectionTimeoutMillis: resolveTimeoutMillis(databaseUrl),
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MILLIS,
  });
}
