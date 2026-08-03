/**
 * AI Diagnostics — AID-6A support pack, part 2: BOUNDED, SANITIZED AUDIT
 * CORRELATION (#2375, epic #2369).
 *
 * PERMISSION, and the one rule that shapes this whole file: correlation requires
 * `support:view` AND the affected domain's own `area:view`. #2375 also forbids
 * doing that with one tool and a model-chosen `domain` argument — an argument
 * cannot decide an authorization rule, because ADR-002 authorizes BEFORE arguments
 * are parsed. So there is one FIXED entry per domain, each declaring its own area
 * set and its own closed category filter, and the executor AND-s them freshly on
 * every invocation.
 *
 *   diagnostics.system_event_correlation      support
 *   diagnostics.booking_event_correlation     support + bookings
 *   diagnostics.membership_event_correlation  support + membership
 *   diagnostics.finance_event_correlation     support + finance
 *   diagnostics.lodge_event_correlation       support + lodge
 *
 * A caller holding only `support:view` is offered — and can only run — the system
 * entry. Asking for `diagnostics.finance_event_correlation` without `finance:view`
 * is denied server-side with `permission_denied` and the missing area named, and
 * NOTHING infers the answer from another source: the system entry's category filter
 * cannot see a payment row, so a finance question cannot be answered around the
 * denial. That is the acceptance criterion "missing permission is a denial, not
 * worked around with source inference", enforced by the category filters rather
 * than by discipline.
 *
 * THE GRANT. This is the ONLY relation AID-6A adds to the `SELECT_GRANTS` allowlist,
 * and it is granted BY COLUMN, not by table:
 *
 *   GRANT SELECT ("id","action","category","severity","outcome","entityType",
 *                 "requestId","createdAt") ON public."AuditLog"
 *
 * `AuditLog` is exactly the shape #2375 says must not be granted wholesale: it
 * carries `ipAddress`, `userAgent`, `summary`, `details`, arbitrary `metadata` JSON,
 * and three member-identifying columns. A column grant makes the projection a
 * SERVER-ENFORCED boundary rather than an application one — as the diagnostics role,
 * `SELECT "ipAddress" FROM "AuditLog"` is refused by PostgreSQL itself (42501), so a
 * future tool, a future projection bug, or a hand-written query in a psql session
 * with that credential cannot reach it. `database.ts`'s privilege probe verifies the
 * granted COLUMNS against this same allowlist and refuses the role if a wider grant
 * appears, so drift towards a table-level grant fails readiness closed.
 *
 * WHAT IS PROJECTED, and why each field is safe:
 *  - `eventRef`   the audit row's own id. #2375 lists "evidence reference" as an
 *                 approved correlation field, and it is what makes the ORDER BY
 *                 total (so the audit `resultHash` is stable for identical evidence).
 *  - `action`     the stable server-defined action code.
 *  - `category`, `severity`, `outcome`  closed server-side classifications.
 *  - `entityType` WHAT kind of record the event concerned, never WHICH one.
 *  - `requestId`  the correlation key that ties one operator action to the events it
 *                 produced. Carries no personal data.
 *  - `occurredAtUtc`  ISO-8601 UTC, formatted in SQL (a `Date` is not a flat scalar).
 *
 * WHAT IS NEVER PROJECTED, and there is no argument that can change it:
 * `entityId`, `memberId`, `actorMemberId`, `subjectMemberId`, `targetId`, `summary`,
 * `details`, `metadata`, `ipAddress`, `userAgent`. `entityId` is the deliberate one
 * to explain: it is often a member id, and this pack's permission set is
 * system-plus-domain rather than a per-record investigation with ADR-004's PII
 * opt-in. Per-record evidence — the member, the booking, the payment — is AID-6B
 * (#2376) and AID-6C (#2377) work, under their own area permission and their own
 * privacy review. So every entry here reports `surfacesPersonalData: false` and
 * means it.
 *
 * BOUNDS. One primary correlation input (an exact request id, optional) plus a fixed
 * approved window from a closed enum; newest first; thirty events; no free-text log
 * search, no `LIKE`, no wildcard, no model-chosen column, ordering or filter.
 *
 * UNTRUSTED TEXT. Every projected string is a server-defined code today, but it
 * comes out of a database and is treated as prompt-injection-capable evidence
 * regardless: it is redacted and length-capped by the executor's projection step and
 * then neutralised by the evidence renderer, which strips angle brackets and quotes
 * so a stored value cannot forge a block delimiter or an instruction.
 */

import { z } from "zod";

import type { AdminPermissionArea } from "@/lib/admin-permissions";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";

/**
 * The approved correlation windows, and the minutes each means. A closed enum
 * rather than a number, so "one primary input and a fixed approved window" is a
 * type, not a validation rule someone can loosen. 7 days is the maximum #2375 sets.
 */
const CORRELATION_WINDOWS = {
  "15m": 15,
  "1h": 60,
  "6h": 360,
  "24h": 1_440,
  "7d": 10_080,
} as const;

type CorrelationWindow = keyof typeof CORRELATION_WINDOWS;

const CORRELATION_WINDOW_KEYS = Object.keys(
  CORRELATION_WINDOWS,
) as [CorrelationWindow, ...CorrelationWindow[]];

/** The default when the model does not choose: #2375's recommended 1 hour. */
const DEFAULT_CORRELATION_WINDOW: CorrelationWindow = "1h";

/**
 * An exact request/trace identifier. EXACT, never a pattern: the predicate is `=`,
 * so there is no `LIKE`, no wildcard and nothing to enumerate with, whatever this
 * accepts. The shape is deliberately permissive about WHICH id scheme (cuid, uuid,
 * and a handful of hand-set references all appear in `AuditLog.requestId`) and
 * strict about length and character class, so a blank, a huge blob, or anything
 * carrying whitespace or quotes is refused before it becomes an audit `argsHash`.
 */
const REQUEST_ID = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

const correlationArgsSchema = z
  .object({
    window: z.enum(CORRELATION_WINDOW_KEYS).default(DEFAULT_CORRELATION_WINDOW),
    requestId: REQUEST_ID.optional(),
  })
  .strict();

type CorrelationArgs = z.infer<typeof correlationArgsSchema>;

const correlationInputSchema = {
  type: "object" as const,
  properties: {
    window: {
      type: "string",
      enum: [...CORRELATION_WINDOW_KEYS],
      description:
        "How far back to look, ending now. Defaults to 1h. 7d is the maximum.",
    },
    requestId: {
      type: "string",
      description:
        "Optional. An exact request or trace identifier to correlate on. Must still fall inside the window.",
    },
  },
  additionalProperties: false as const,
};

/**
 * The window predicate is ALWAYS applied, including when a request id is supplied,
 * and that is a performance control rather than a policy one: `AuditLog` has no
 * index on `requestId`, so a request-id-only predicate would be a sequential scan
 * of the platform's whole access trail against a 5-second statement timeout. Every
 * category this pack filters on IS indexed together with `createdAt`
 * (`@@index([category, createdAt])`), so the window is what keeps the read cheap.
 * The consequence is documented in the tool descriptions: widen the window if the
 * event you are correlating is older than an hour.
 *
 * `$3::text IS NULL OR "requestId" = $3::text` keeps the entry to ONE statement with
 * a fixed parameter arity — the alternative (two SQL texts chosen by an argument)
 * would be a query shape the caller selects, which is the thing this substrate
 * exists to refuse.
 *
 * EVERY TIME EXPRESSION IS TIMEZONE-INDEPENDENT, deliberately. `AuditLog."createdAt"`
 * is a naive `timestamp` holding UTC, so `now()` (a `timestamptz`) is converted to a
 * UTC `timestamp` with `AT TIME ZONE 'UTC'` before the comparison, and `to_char` is
 * applied to the plain column rather than to a `timestamptz`. Both matter: comparing
 * `timestamp` against `timestamptz` directly, or formatting a `timestamptz`, is
 * resolved using the SESSION's `TimeZone`, so on a deployment that sets
 * `Pacific/Auckland` the window would shift by 12-13 hours and the projected instant
 * would be local time labelled `Z`. The executor also pins `TimeZone` to UTC per
 * transaction; this statement does not rely on that.
 *
 * ONE SQL TEXT FOR ALL FIVE ENTRIES, and the category set travels as a BOUND
 * PARAMETER (`$1::text[]`) rather than being formatted into the statement. The
 * category lists are module constants, not caller text, so interpolating them would
 * not have been an injection — but this file would then be the one place in the
 * substrate that builds SQL with string concatenation, and "it is safe because of
 * where the values come from" is an argument a future edit can quietly invalidate.
 * `bind` closes over the ENTRY's own categories, never over an argument, so the
 * permission set and the category filter remain fixed together at review time.
 */
const CORRELATION_SQL = `SELECT
  a."id" AS event_ref,
  a."action" AS action_code,
  a."category" AS category,
  a."severity" AS severity,
  a."outcome" AS outcome,
  a."entityType" AS entity_type,
  a."requestId" AS request_id,
  pg_catalog.to_char(a."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at_utc
FROM public."AuditLog" a
WHERE a."category" = ANY ($1::text[])
  AND a."createdAt" >= (pg_catalog.now() AT TIME ZONE 'UTC') - (($2)::int * INTERVAL '1 minute')
  AND ($3::text IS NULL OR a."requestId" = $3::text)
ORDER BY a."createdAt" DESC, a."id" ASC`;

/**
 * Thirty events, not the fifty #2375 allows as a maximum. The substrate renders a
 * tool result into an evidence block capped at 8 000 characters, and fifty rows of
 * this shape do not fit: the block would clip its own tail and the model would see a
 * generic truncation notice instead of the substrate's honest `truncated` flag over a
 * complete prefix. Thirty rows render whole, newest first, with truncation reported
 * when there were more — which is the answer an operator can act on.
 */
const CORRELATION_ROW_LIMIT = 30;

/** ~230 bytes per projected row at 30 rows, with margin for a long action code. */
const CORRELATION_BYTE_LIMIT = 12_288;

function defineCorrelationTool(input: {
  id: string;
  label: string;
  requiredAreas: readonly AdminPermissionArea[];
  categories: readonly string[];
  description: string;
}): DiagnosticsToolEntry {
  return defineDiagnosticsTool<CorrelationArgs>({
    id: input.id,
    source: "select_only_sql",
    label: input.label,
    description: input.description,
    requiredAreas: input.requiredAreas,
    argsSchema: correlationArgsSchema,
    inputSchema: correlationInputSchema,
    sql: CORRELATION_SQL,
    // Three parameters, always, in this order — the ENTRY's own category set (a
    // module constant, never an argument), the window in minutes (resolved from the
    // closed enum, never a caller-supplied number), and the exact request id or an
    // explicit null. The executor appends the row cap as `$4`.
    bind: (args) => [
      [...input.categories],
      CORRELATION_WINDOWS[args.window],
      args.requestId ?? null,
    ],
    project: (row) => ({
      eventRef: String(row.event_ref ?? ""),
      action: String(row.action_code ?? ""),
      category: row.category === null ? null : String(row.category ?? ""),
      severity: row.severity === null ? null : String(row.severity ?? ""),
      outcome: row.outcome === null ? null : String(row.outcome ?? ""),
      entityType: row.entity_type === null ? null : String(row.entity_type ?? ""),
      requestId: row.request_id === null ? null : String(row.request_id ?? ""),
      occurredAtUtc: String(row.occurred_at_utc ?? ""),
    }),
    rowLimit: CORRELATION_ROW_LIMIT,
    byteLimit: CORRELATION_BYTE_LIMIT,
    surfacesPersonalData: false,
  });
}

export const DIAGNOSTICS_SYSTEM_CORRELATION_TOOL_ID =
  "diagnostics.system_event_correlation";
export const DIAGNOSTICS_BOOKING_CORRELATION_TOOL_ID =
  "diagnostics.booking_event_correlation";
export const DIAGNOSTICS_MEMBERSHIP_CORRELATION_TOOL_ID =
  "diagnostics.membership_event_correlation";
export const DIAGNOSTICS_FINANCE_CORRELATION_TOOL_ID =
  "diagnostics.finance_event_correlation";
export const DIAGNOSTICS_LODGE_CORRELATION_TOOL_ID =
  "diagnostics.lodge_event_correlation";

/**
 * The audit categories each entry may read. DISJOINT and CLOSED, and both
 * properties are pinned by `support-correlation.test.ts`:
 *
 *  - DISJOINT, so a row is reachable through exactly one permission set. If
 *    `payment` appeared in the system entry as well, `support:view` alone would
 *    reach finance evidence and the domain requirement would be decoration.
 *  - CLOSED, so a category no entry declares is reachable by NO correlation tool.
 *    `AuditCategory` is an open union (`… | (string & {})`), so a future feature can
 *    write a category nobody here has reviewed; the fail-closed answer is that it
 *    stays invisible to Diagnostics until a pull request adds it to a declared set,
 *    which is the same deliberate friction ADR-007 puts on a table grant.
 */
const SYSTEM_CATEGORIES = ["system", "security", "admin", "communication"] as const;
const BOOKING_CATEGORIES = ["booking"] as const;
const MEMBERSHIP_CATEGORIES = ["account", "privacy"] as const;
const FINANCE_CATEGORIES = ["payment", "xero"] as const;
const LODGE_CATEGORIES = ["lodge"] as const;

/** Exported for the contract test that pins disjointness and coverage. */
export const DIAGNOSTICS_CORRELATION_CATEGORY_SETS: Readonly<
  Record<string, readonly string[]>
> = {
  [DIAGNOSTICS_SYSTEM_CORRELATION_TOOL_ID]: SYSTEM_CATEGORIES,
  [DIAGNOSTICS_BOOKING_CORRELATION_TOOL_ID]: BOOKING_CATEGORIES,
  [DIAGNOSTICS_MEMBERSHIP_CORRELATION_TOOL_ID]: MEMBERSHIP_CATEGORIES,
  [DIAGNOSTICS_FINANCE_CORRELATION_TOOL_ID]: FINANCE_CATEGORIES,
  [DIAGNOSTICS_LODGE_CORRELATION_TOOL_ID]: LODGE_CATEGORIES,
};

const SHARED_DESCRIPTION_TAIL =
  "Returns only stable codes and timestamps: the event reference, action code, category, severity, outcome, what kind of record it concerned, the request identifier, and when it happened in UTC. It never returns which record, which member, event descriptions, stored metadata, IP addresses, user agents or error text. Newest first, at most 30 events, and the window always applies — widen it if the event you are looking for is older.";

export const DIAGNOSTICS_SUPPORT_CORRELATION_TOOLS: readonly DiagnosticsToolEntry[] =
  [
    defineCorrelationTool({
      id: DIAGNOSTICS_SYSTEM_CORRELATION_TOOL_ID,
      label: "System and security event correlation",
      requiredAreas: ["support"],
      categories: SYSTEM_CATEGORIES,
      description: `Correlates recent system, security, administration and communication audit events, optionally for one exact request identifier. Use it to see what the platform recorded around an incident. ${SHARED_DESCRIPTION_TAIL}`,
    }),
    defineCorrelationTool({
      id: DIAGNOSTICS_BOOKING_CORRELATION_TOOL_ID,
      label: "Booking event correlation",
      requiredAreas: ["support", "bookings"],
      categories: BOOKING_CATEGORIES,
      description: `Correlates recent booking audit events, optionally for one exact request identifier. Use it to see what the platform recorded around a booking problem. ${SHARED_DESCRIPTION_TAIL}`,
    }),
    defineCorrelationTool({
      id: DIAGNOSTICS_MEMBERSHIP_CORRELATION_TOOL_ID,
      label: "Membership event correlation",
      requiredAreas: ["support", "membership"],
      categories: MEMBERSHIP_CATEGORIES,
      description: `Correlates recent membership, account and privacy audit events, optionally for one exact request identifier. Use it to see what the platform recorded around a membership problem. ${SHARED_DESCRIPTION_TAIL}`,
    }),
    defineCorrelationTool({
      id: DIAGNOSTICS_FINANCE_CORRELATION_TOOL_ID,
      label: "Finance and Xero event correlation",
      requiredAreas: ["support", "finance"],
      categories: FINANCE_CATEGORIES,
      description: `Correlates recent payment and Xero audit events, optionally for one exact request identifier. Use it to see what the platform recorded around a payment or invoicing problem. ${SHARED_DESCRIPTION_TAIL}`,
    }),
    defineCorrelationTool({
      id: DIAGNOSTICS_LODGE_CORRELATION_TOOL_ID,
      label: "Lodge operations event correlation",
      requiredAreas: ["support", "lodge"],
      categories: LODGE_CATEGORIES,
      description: `Correlates recent lodge-operations audit events, optionally for one exact request identifier. Use it to see what the platform recorded around a rosters, chores, work-party or lodge-settings problem. ${SHARED_DESCRIPTION_TAIL}`,
    }),
  ];
