import "server-only";
import { z } from "zod";
import { getOperationalServerNzApiKey } from "@/lib/servernz-config";
import {
  loadServerNzSettings,
  validateCentralServerBaseUrl,
} from "@/lib/servernz-settings";

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

/**
 * A lodge as the central server sends it, held to the SAME bounds the club's own
 * officer is held to in `POST /api/admin/other-lodges` (name 120, location 300,
 * officer name 200, email 320, phone 50, capacity 0..100000).
 *
 * Matching those bounds is the point. `getPublicOtherLodges()` serves `id + name`
 * on the UNAUTHENTICATED booking-request settings endpoint, which renders on the
 * public form — so without a cap the central server controls unbounded text on
 * every connected club's public page, while the local admin typing the same row
 * is validated. Trusting the remote MORE than the local admin is the inversion.
 *
 * It also removes a partial-merge failure mode: `location`, `bookingOfficerName`,
 * `bookingOfficerEmail` and `bookingOfficerPhone` are VarChar-capped columns, so
 * an over-long value would raise a 22001 mid-loop — after earlier rows were
 * written, with no transaction around the loop and before the cursor advanced.
 * A row that fails these bounds is dropped by `pullOtherLodges` instead, which
 * costs one row rather than the rest of the batch.
 */
const distributedLodgeSchema = z.object({
  id: z.string().max(64),
  name: z.string().trim().min(1).max(120),
  location: z.string().trim().max(300).nullable(),
  bookingOfficerName: z.string().trim().max(200).nullable(),
  bookingOfficerEmail: z.string().trim().max(320).nullable(),
  bookingOfficerPhone: z.string().trim().max(50).nullable(),
  bedCapacity: z.number().int().min(0).max(100000).nullable(),
  updatedAt: z.string().max(64),
});

/** Upper bound on one pull, so a hostile or broken server cannot stream forever. */
const MAX_LODGES_PER_PULL = 5_000;

// No exported alias for a single distributed lodge: nothing names one on its
// own, and callers reach them through `OtherLodgesPullResult["lodges"]`.
//
// Rows arrive as `unknown` and are validated one at a time below, so ONE bad row
// costs that row rather than the whole batch. `cursor` is capped at 64 to match
// `ServerNzSettings.otherLodgesCursor`'s VarChar(64): an over-long cursor would
// otherwise raise P2000 AFTER the rows were written and BEFORE the cursor
// advanced, so every subsequent run would re-fetch and re-fail, permanently.
const pullEnvelopeSchema = z.object({
  lodges: z.array(z.unknown()).max(MAX_LODGES_PER_PULL),
  cursor: z.string().max(64).nullable(),
  count: z.number(),
});

export interface OtherLodgesPullResult {
  lodges: z.infer<typeof distributedLodgeSchema>[];
  cursor: string | null;
  count: number;
  /** Rows the server sent that failed the bounds above and were discarded. */
  dropped: number;
}

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
  // Re-checked at REQUEST time, not only where an admin types it. The stored
  // value predates this guard on any deployment that configured the server
  // earlier, and a validator that only runs on the write path leaves those rows
  // sending a bearer token wherever they already point.
  const check = validateCentralServerBaseUrl(settings.baseUrl);
  if (!check.ok) {
    throw new ServerNzNotConfiguredError(
      `The stored Alpine Central Server base URL is not usable: ${check.reason}`,
    );
  }
  return { baseUrl: check.value as string, apiKey };
}

function authHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

/** Longest remote-supplied error text we will carry into a message or audit row. */
const MAX_REMOTE_ERROR_CHARS = 200;

/**
 * The remote's own error text, bounded and stripped of control characters.
 *
 * This string travels: `respondToSyncError` writes it into the audit `details`
 * column and shows it in the admin UI. `sanitizeAuditDetails` catches `key=value`
 * shapes, card numbers and long HTML, but a bare token echoed back by a remote
 * server matches none of those — so the honest fix is to stop treating the
 * remote's text as free-form. Bounded here, at the one place it enters.
 */
async function readError(res: Response): Promise<string> {
  const fallback = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error !== "string" || !body.error.trim()) return fallback;
    const cleaned = body.error
      // eslint-disable-next-line no-control-regex -- stripping C0/C1 controls is the point
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_REMOTE_ERROR_CHARS);
    return cleaned || fallback;
  } catch {
    return fallback;
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
  const envelope = pullEnvelopeSchema.parse(await res.json());

  // Per-row validation: a row the server sends that breaks the bounds above is
  // discarded rather than aborting the batch. Dropping one row loses one club's
  // details until the server sends a valid version; throwing would lose the
  // whole pull AND leave the cursor unadvanced, so the same bad row would be
  // re-fetched and re-fail on every subsequent run.
  const lodges: z.infer<typeof distributedLodgeSchema>[] = [];
  let dropped = 0;
  for (const raw of envelope.lodges) {
    const row = distributedLodgeSchema.safeParse(raw);
    if (row.success) lodges.push(row.data);
    else dropped++;
  }

  return { lodges, cursor: envelope.cursor, count: envelope.count, dropped };
}
