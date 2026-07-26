/**
 * Reads the connected Xero organisation's accounting financial year-end month.
 *
 * Used as the default for the membership financial year (an admin can override
 * it when the membership subscription year differs from the accounting year).
 * The value changes almost never, so it is cached in-process with a long TTL.
 * Each serverless instance fetches at most once per TTL.
 */

import logger from "@/lib/logger";
import { parseDateOnly } from "@/lib/date-only";
import {
  fetchMockXeroOrganisation,
  getXeroMockInternalOrigin,
} from "@/lib/xero-mock-endpoint";
import { registerXeroOrganisationCacheInvalidator } from "@/lib/xero-organisation-cache-bus";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";

const ORG_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface OrgYearEndCacheEntry {
  month: number | null;
  fetchedAt: number;
}

let cached: OrgYearEndCacheEntry | null = null;

/**
 * Returns the Xero organisation's financial year-end month (1-12), or null if
 * Xero is not connected or the value is unavailable. Cached in-process.
 */
export async function getXeroFinancialYearEndMonth(
  forceRefresh = false,
): Promise<number | null> {
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < ORG_CACHE_TTL_MS
  ) {
    return cached.month;
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getOrganisations(tenantId),
      {
        operation: "getOrganisations",
        resourceType: "ORGANISATION",
        workflow: "membershipFinancialYear",
        context: "xero-organisation getFinancialYearEndMonth",
      },
    );
    const raw = response.body.organisations?.[0]?.financialYearEndMonth;
    const month =
      typeof raw === "number" && raw >= 1 && raw <= 12 ? raw : null;
    cached = { month, fetchedAt: Date.now() };
    return month;
  } catch (error) {
    logger.warn(
      { err: error },
      "Failed to read Xero organisation financial year-end month",
    );
    // Fall back to the last cached value if we have one, otherwise null.
    return cached?.month ?? null;
  }
}

// ---------------------------------------------------------------------------
// Connected-organisation summary (#2080): the org NAME (+ year-end month) so the
// setup wizard's step 3 can confirm the operator linked the RIGHT Xero org after
// the OAuth round-trip. Cached in-process with the same long TTL as the
// year-end read; a status/summary read must never mutate the DB.
//
// #2261 adds the org SHORT CODE to the same summary — the only identifier the
// Xero web app accepts in a deep link (the tenant GUID we store is not usable
// in a Xero URL). It rides along on the getOrganisations response this summary
// already fetches, so widening the summary with it costs no extra Xero call —
// but the Xero Sync page is a NEW caller of the summary, so its "Go to Xero"
// button does cost one live read per server process per TTL (the first load
// after a restart, after the TTL expires, or after a connect/disconnect; every
// load after that costs none). That one read backs every consumer of this
// summary: the setup wizard's org confirmation, the Xero Sync page's deep link,
// and the subscription-lockout settings panel, which all read
// `/api/admin/xero/organisation`.
//
// #2261 review (F1/F2) hardened the "one read per TTL" claim for the case that
// actually matters — a connection that is PRESENT but FAILING (revoked refresh
// token awaiting re-entry, an org read 500, a per-minute 429 during a bulk
// sync). Before, a failed read cached nothing, so every admin page load
// re-attempted a live call in exactly the state where admins reload most. Now a
// failure is cached under a short NEGATIVE TTL, concurrent cold-cache callers
// share one in-flight read, and the read itself does not retry.
// ---------------------------------------------------------------------------

export interface XeroConnectedOrganisation {
  name: string | null;
  financialYearEndMonth: number | null;
  /**
   * Xero's organisation short code (e.g. `!aBc12`), or null when unavailable.
   * Callers must treat null as "build the generic go.xero.com link" — never as
   * a reason to hide or disable the link.
   */
  shortCode: string | null;
}

/** Empty summary: the shape a failed/never-run read degrades to. */
const EMPTY_ORG_SUMMARY: XeroConnectedOrganisation = {
  name: null,
  financialYearEndMonth: null,
  shortCode: null,
};

/**
 * Normalise Xero's `Organisation.shortCode` to a usable value or null. Same
 * extraction as `findDuplicateContacts` (`xero-duplicate-contacts.ts`), except
 * that this returns null rather than "" so the deep-link builders' falsy check
 * and the API contract agree on one absent value.
 */
function normaliseShortCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * How long a FAILED organisation read is remembered (#2261 review, F1).
 *
 * Short enough that an admin who fixes the connection (re-entering credentials,
 * reconnecting, waiting out a per-minute 429) sees the org come back on the
 * next page load or two, but long enough that a page an admin is reloading
 * while Xero is broken cannot turn into one live Xero call per request.
 */
const ORG_SUMMARY_FAILURE_TTL_MS = 60 * 1000; // 60 seconds

interface OrgSummaryCacheEntry {
  summary: XeroConnectedOrganisation;
  fetchedAt: number;
  /**
   * True when this entry records a FAILED read. Failed entries expire under
   * {@link ORG_SUMMARY_FAILURE_TTL_MS} instead of the 12-hour TTL, and any
   * later successful read replaces them outright — so a negative entry can
   * never pin a stale summary for hours.
   */
  failed: boolean;
}

let orgSummaryCache: OrgSummaryCacheEntry | null = null;

/**
 * The read currently in flight, shared by every caller that arrives while it
 * runs (#2261 review, F2) — same single-flight shape as the token-refresh mutex
 * in `xero-api-client` (`_tokenRefreshPromise`). Without it, N concurrent
 * cold-cache requests make N `getOrganisations` calls; with F1's negative cache
 * the window is bounded, but the two fixes belong together: while Xero is
 * failing the cache is cold most often, which is exactly when a stampede hurts.
 */
let orgSummaryInFlight: Promise<XeroConnectedOrganisation> | null = null;

/**
 * Bumped on every cache reset. A read that started before a connect/disconnect
 * invalidation describes the OLD organisation, so it must not write itself into
 * the freshly cleared cache — it is served to its own callers and dropped.
 */
let orgSummaryGeneration = 0;

/** The cached summary if it is still fresh for its kind, otherwise null. */
function freshOrgSummary(): XeroConnectedOrganisation | null {
  if (!orgSummaryCache) return null;
  const ttl = orgSummaryCache.failed
    ? ORG_SUMMARY_FAILURE_TTL_MS
    : ORG_CACHE_TTL_MS;
  return Date.now() - orgSummaryCache.fetchedAt < ttl
    ? orgSummaryCache.summary
    : null;
}

/**
 * One live (or mocked) organisation read. Never throws: both the mock and the
 * live path funnel failures into the same catch, which caches the failure under
 * the short negative TTL and degrades to the last known summary (or nulls).
 */
async function readXeroConnectedOrganisation(): Promise<XeroConnectedOrganisation> {
  const generation = orgSummaryGeneration;
  const remember = (
    summary: XeroConnectedOrganisation,
    failed: boolean,
  ): XeroConnectedOrganisation => {
    if (generation === orgSummaryGeneration) {
      orgSummaryCache = { summary, fetchedAt: Date.now(), failed };
    }
    return summary;
  };

  try {
    // Server-side fetch — use the in-container origin (see getXeroMockInternalOrigin).
    const mockOrigin = getXeroMockInternalOrigin();
    if (mockOrigin) {
      const mock = await fetchMockXeroOrganisation(mockOrigin);
      return remember(
        {
          name: mock.name,
          financialYearEndMonth: mock.financialYearEndMonth,
          shortCode: normaliseShortCode(mock.shortCode),
        },
        false,
      );
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getOrganisations(tenantId),
      {
        operation: "getOrganisations",
        resourceType: "ORGANISATION",
        workflow: "setupWizardOrgConfirmation",
        context: "xero-organisation getConnectedOrganisation",
        // Do not wait out a RATE LIMIT (#2261 review, F1): this read only
        // decorates a page — a slow one is worth less than the admin request it
        // holds open. withXeroRetry would otherwise wait out a per-minute 429 up
        // to three times (capped at 120s each), holding the request open for
        // minutes and competing for the same minute budget as the sync that
        // caused the 429. One attempt, cached failure, try again in a minute.
        maxRetries: 0,
        // But KEEP the transient (5xx/408) budget at withXeroRetry's default of
        // 1, because `maxTransientRetries` otherwise defaults to
        // `min(maxRetries, 1)` — so `maxRetries: 0` alone would also zero it.
        // That matters far beyond this read: exhausting the transient budget
        // calls `rememberXeroTransientOutage`, the PROCESS-GLOBAL breaker that
        // fails every subsequent Xero call fast for two minutes, invoicing and
        // sync included. A decorative read must not be able to trip that on its
        // own first 5xx; with the budget intact it takes two consecutive
        // transient failures, exactly as it did before this feature existed.
        maxTransientRetries: 1,
      },
    );
    const org = response.body.organisations?.[0];
    const rawMonth = org?.financialYearEndMonth;
    return remember(
      {
        name: org?.name ?? null,
        financialYearEndMonth:
          typeof rawMonth === "number" && rawMonth >= 1 && rawMonth <= 12
            ? rawMonth
            : null,
        shortCode: normaliseShortCode(org?.shortCode),
      },
      false,
    );
  } catch (error) {
    logger.warn(
      { err: error },
      "Failed to read Xero connected organisation summary",
    );
    // Negative-cache the failure, keeping the last known summary as the served
    // value so a transient blip does not blank a name we already have.
    return remember(orgSummaryCache?.summary ?? EMPTY_ORG_SUMMARY, true);
  }
}

/**
 * Returns the connected Xero organisation's name, financial year-end month and
 * deep-link short code, or nulls when Xero is not connected / unavailable.
 * Never throws — a failed read falls back to the last cached summary (or
 * nulls). Cached in-process: 12 hours for a successful read, one minute for a
 * failed one, with concurrent cold-cache callers sharing a single read.
 *
 * The cache entry holds the whole summary object, so widening
 * {@link XeroConnectedOrganisation} needs no cache-shape change and no change
 * to {@link resetXeroOrganisationCaches} (which nulls the entry wholesale,
 * negative entries included) or to the connect/disconnect invalidation bus.
 *
 * Honours the test-only mock-Xero harness (#2080): inert in production.
 */
export async function getXeroConnectedOrganisation(
  forceRefresh = false,
): Promise<XeroConnectedOrganisation> {
  if (!forceRefresh) {
    const fresh = freshOrgSummary();
    if (fresh) return fresh;
    if (orgSummaryInFlight) return orgSummaryInFlight;
  }

  // `readXeroConnectedOrganisation` never rejects, so joining callers can never
  // be handed a rejection; the `finally` still clears the slot defensively so a
  // future failure mode cannot wedge the cache into "permanently in flight".
  const inFlight: Promise<XeroConnectedOrganisation> =
    readXeroConnectedOrganisation().finally(() => {
      if (orgSummaryInFlight === inFlight) orgSummaryInFlight = null;
    });
  orgSummaryInFlight = inFlight;
  return inFlight;
}

// ---------------------------------------------------------------------------
// Xero lock dates (#1695): the accounting period lock date and end-of-year
// lock date. A retroactive booking whose check-in (its Xero invoice issue date)
// falls on or before the effective lock date is rejected at create time, so the
// invoice never has to post into a locked period. Cached with a short TTL — the
// admin can unlock the period in Xero and retry within a few minutes.
// ---------------------------------------------------------------------------

const LOCK_DATES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface XeroLockDates {
  periodLockDate: Date | null;
  endOfYearLockDate: Date | null;
}

interface OrgLockDatesCacheEntry {
  lockDates: XeroLockDates;
  fetchedAt: number;
}

let lockDatesCache: OrgLockDatesCacheEntry | null = null;

/**
 * Parse a Xero lock-date value into a date-only Date, or null when unset or
 * unparseable. xero-node TYPES these fields as optional strings, but its
 * ObjectSerializer converts any string payload starting with `/Date(` into a
 * JS Date at runtime (deserializeDateFormats), so when an organisation has a
 * lock date set the value arrives here as a Date object. A raw string can
 * still appear as a Microsoft-JSON `/Date(1234567890000+1300)/` timestamp or
 * an ISO date string, so all three shapes must parse.
 */
function parseXeroLockDate(value: string | Date | undefined | null): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) {
      // Normalize to a date-only Date in UTC, matching the MS-JSON path below.
      const parsed = parseDateOnly(value.toISOString().slice(0, 10));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    logger.warn({ value }, "Unparseable Xero lock date; treating as unset");
    return null;
  }

  const msJson = /\/Date\((\d+)/.exec(value);
  if (msJson) {
    const epochMs = Number(msJson[1]);
    if (Number.isFinite(epochMs)) {
      // Normalize to a date-only Date in UTC (lock dates are whole days).
      const parsed = parseDateOnly(new Date(epochMs).toISOString().slice(0, 10));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  } else {
    const parsed = parseDateOnly(value.slice(0, 10));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  // A SET but unrecognisable lock date must not silently disable the guard —
  // treat-as-unset fails open, so make the format drift loud.
  logger.warn({ value }, "Unparseable Xero lock date; treating as unset");
  return null;
}

/**
 * Returns the connected Xero organisation's period and end-of-year lock dates
 * as date-only Dates (null when unset). Cached in-process for a few minutes.
 *
 * Unlike getXeroFinancialYearEndMonth, this THROWS on a fetch failure when no
 * fresh cache is available: the retroactive-booking route fails closed rather
 * than silently skipping the lock-date guard.
 */
export async function getXeroLockDates(
  forceRefresh = false,
): Promise<XeroLockDates> {
  if (
    !forceRefresh &&
    lockDatesCache &&
    Date.now() - lockDatesCache.fetchedAt < LOCK_DATES_CACHE_TTL_MS
  ) {
    return lockDatesCache.lockDates;
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getOrganisations(tenantId),
      {
        operation: "getOrganisations",
        resourceType: "ORGANISATION",
        workflow: "retroactiveBookingLockDates",
        context: "xero-organisation getLockDates",
      },
    );
    const org = response.body.organisations?.[0];
    const lockDates: XeroLockDates = {
      periodLockDate: parseXeroLockDate(org?.periodLockDate),
      endOfYearLockDate: parseXeroLockDate(org?.endOfYearLockDate),
    };
    lockDatesCache = { lockDates, fetchedAt: Date.now() };
    return lockDates;
  } catch (error) {
    // Fail closed: a fresh cache satisfies the caller, otherwise re-throw so
    // the route returns a retryable error instead of skipping the guard.
    if (
      lockDatesCache &&
      Date.now() - lockDatesCache.fetchedAt < LOCK_DATES_CACHE_TTL_MS
    ) {
      return lockDatesCache.lockDates;
    }
    logger.warn({ err: error }, "Failed to read Xero organisation lock dates");
    throw error;
  }
}

/**
 * The effective lock date is the later of the two set dates: a booking must
 * clear whichever period is locked further into the future. Null when neither
 * is set.
 */
export function getEffectiveXeroLockDate(lockDates: XeroLockDates): Date | null {
  const { periodLockDate, endOfYearLockDate } = lockDates;
  if (periodLockDate && endOfYearLockDate) {
    return periodLockDate.getTime() >= endOfYearLockDate.getTime()
      ? periodLockDate
      : endOfYearLockDate;
  }
  return periodLockDate ?? endOfYearLockDate ?? null;
}

// test seam
export function resetXeroLockDatesCacheForTests(): void {
  lockDatesCache = null;
}

// ---------------------------------------------------------------------------
// Cache invalidation (#2080 review, CORRECTNESS-F1): every cache above is keyed
// on the CONNECTED Xero organisation. When the connection identity changes —
// a connect/reconnect saves new tokens (possibly a DIFFERENT org) or a
// disconnect drops them — those caches are stale and must be reset, or the
// setup wizard's "is this the right org?" step would confirm the OLD org's name.
// The token store fires this via the dependency-free bus (no import cycle).
// ---------------------------------------------------------------------------

/** Reset every in-process organisation cache (name/FYE, summary, lock dates). */
function resetXeroOrganisationCaches(): void {
  cached = null;
  // Nulls positive AND negative summary entries: after a reconnect the next
  // read must go live even if the last attempt failed seconds ago.
  orgSummaryCache = null;
  lockDatesCache = null;
  // Abandon any summary read already in flight: it describes the old
  // connection, so neither its result nor its cache write may survive.
  orgSummaryInFlight = null;
  orgSummaryGeneration += 1;
}

registerXeroOrganisationCacheInvalidator(resetXeroOrganisationCaches);

// test seam
export function resetXeroOrganisationCachesForTests(): void {
  resetXeroOrganisationCaches();
}
