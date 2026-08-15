import "server-only";
import { z } from "zod";
import { getOperationalServerNzApiKey } from "@/lib/servernz-config";
import { loadServerNzSettings } from "@/lib/servernz-settings";

/**
 * Outbound client for the Alpine Central Server (ServerNZ) REST API. Mirrors the
 * addy-api.ts pattern: native fetch, Bearer auth, Zod-validated responses, and
 * an explicit request timeout (fetch has none by default).
 *
 * The API key is resolved from the encrypted credential store and the base URL
 * from ServerNzSettings — neither is ever logged.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export class ServerNzNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerNzNotConfiguredError";
  }
}

export class ServerNzApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ServerNzApiError";
    this.status = status;
  }
}

/** A lodge entry pushed up to the server. `distribute` is never sent by clients. */
export interface OtherLodgeUploadItem {
  name: string;
  location?: string | null;
  bookingOfficerName?: string | null;
  bookingOfficerEmail?: string | null;
  bookingOfficerPhone?: string | null;
  bedCapacity?: number | null;
}

const uploadResultSchema = z.object({
  created: z.number(),
  updated: z.number(),
  // Rows the server received but left unchanged (identical to what it stored).
  // Defaulted so an older server that omits the field still validates.
  unchanged: z.number().default(0),
  skipped: z.number(),
  results: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(["created", "updated", "unchanged", "skipped"]),
        reason: z.string().optional(),
      }),
    )
    .default([]),
});
export type OtherLodgesUploadResult = z.infer<typeof uploadResultSchema>;

const distributedLodgeSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string().nullable(),
  bookingOfficerName: z.string().nullable(),
  bookingOfficerEmail: z.string().nullable(),
  bookingOfficerPhone: z.string().nullable(),
  bedCapacity: z.number().nullable(),
  updatedAt: z.string(),
});
export type DistributedLodge = z.infer<typeof distributedLodgeSchema>;

const pullResultSchema = z.object({
  lodges: z.array(distributedLodgeSchema),
  cursor: z.string().nullable(),
  count: z.number(),
});
export type OtherLodgesPullResult = z.infer<typeof pullResultSchema>;

async function resolveConnection(): Promise<{ baseUrl: string; apiKey: string }> {
  const [apiKey, settings] = await Promise.all([
    getOperationalServerNzApiKey(),
    loadServerNzSettings(),
  ]);
  if (!settings.baseUrl) {
    throw new ServerNzNotConfiguredError(
      "The Alpine Central Server base URL is not set.",
    );
  }
  if (!apiKey) {
    throw new ServerNzNotConfiguredError(
      "No Alpine Central Server API key is stored.",
    );
  }
  return { baseUrl: settings.baseUrl, apiKey };
}

function authHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body?.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Upload the club's Other Clubs entries to the central server. */
export async function uploadOtherLodges(
  lodges: OtherLodgeUploadItem[],
): Promise<OtherLodgesUploadResult> {
  const { baseUrl, apiKey } = await resolveConnection();
  const res = await fetch(`${baseUrl}/api/v1/other-lodges`, {
    method: "POST",
    cache: "no-store",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ lodges }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new ServerNzApiError(res.status, await readError(res));
  return uploadResultSchema.parse(await res.json());
}

/** Pull the distributed Other Clubs set from the central server. */
export async function pullOtherLodges(
  since?: string | null,
): Promise<OtherLodgesPullResult> {
  const { baseUrl, apiKey } = await resolveConnection();
  const url = new URL(`${baseUrl}/api/v1/other-lodges`);
  if (since) url.searchParams.set("since", since);
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new ServerNzApiError(res.status, await readError(res));
  return pullResultSchema.parse(await res.json());
}
