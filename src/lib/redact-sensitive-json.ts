const REDACTED_SECRET = "[REDACTED]";

/**
 * Recursion bounds for the object walk (#2683).
 *
 * `redactSensitiveJson` used to recurse with no depth limit and no
 * circular-reference guard. Hand it a Prisma result carrying a self-referencing
 * relation — a member whose family group lists the member — and it recursed
 * until the stack overflowed. Because this redactor sits inside pino's `log`
 * formatter (`src/lib/logger.ts`) and Sentry's `beforeSend`
 * (`src/instrumentation-client.ts`), the overflow happened while the server was
 * trying to LOG something, usually from inside an error handler: the process
 * died instead of recording why it was unhappy. That is an availability
 * failure, not only a privacy one.
 *
 * The cap value, the WeakSet and the marker strings deliberately mirror the
 * audit-metadata sanitiser at `src/lib/audit.ts` (`MAX_METADATA_DEPTH`), so a
 * reader meets one vocabulary across both sanitisers rather than two.
 *
 * TRUNCATION IS ALWAYS VISIBLE. A branch cut by the depth cap is replaced by
 * the literal `[TRUNCATED]`, and a back-reference by `[Circular]`. Neither is
 * dropped, emptied or silently flattened — a redactor that quietly deleted
 * fields would hide the very error context the log exists to capture, which is
 * exactly the trade this guard must not make.
 *
 * Only OBJECTS and ARRAYS are subject to the cap. Scalars are returned at any
 * depth, so a deep leaf value still survives even when the structure around it
 * does not.
 *
 * ONE DELIBERATE DIFFERENCE from `audit.ts`: the WeakSet here tracks the
 * ANCESTOR PATH — an object is removed again on the way back out — rather than
 * every object ever visited. `audit.ts` never removes, so the second sibling
 * reference to one shared object is reported as `[Circular]` when nothing is
 * circular at all. In an audit row that is a cosmetic loss; in a log line it
 * would blank a payload an operator is reading to diagnose an incident.
 * Ancestor-only tracking reports exactly the references that would not
 * terminate. Its cost is that a shared, non-circular subtree is rendered once
 * per path that reaches it, and the depth cap bounds that.
 */
const MAX_REDACTION_DEPTH = 6;
const TRUNCATED_BRANCH = "[TRUNCATED]";
const CIRCULAR_REFERENCE = "[Circular]";

const SENSITIVE_JSON_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "apikey",
  "password",
  "stripetoken",
  "email",
  "phone",
  "phonenumber",
  "mobilephone",
  "paymentmethod",
  "paymentmethodid",
  "charge",
  "chargeid",
  "clientreferenceid",
  // Person fields (#2683). `dateofbirth` is covered by the fragment below;
  // "dob" is the one spelling a fragment cannot reach.
  "dob",
]);
const SENSITIVE_JSON_KEY_FRAGMENTS = new Set([
  "email",
  "phone",
  "paymentmethod",
  "charge",
  "clientreferenceid",
  // AI help assistant (#2211): a free-text question, its transcript, and the
  // client-supplied page state are user content that must never land in a log
  // or audit payload. Fragment matches also cover keys like "questionChars".
  "question",
  "transcript",
  "pagecontext",
  // Person fields (#2683), from `Member` in prisma/schema.prisma. Emails and
  // phone numbers are caught a second time by the value-shaped patterns below,
  // so a missing key name still cannot leak one. Names and addresses have NO
  // such fallback — nothing about the string "12 Example Street" identifies it
  // as an address — so the key name is the only line of defence and these are
  // fragments rather than exact keys: `memberFirstName`, `actor_last_name` and
  // `Contact.FirstName` all have to be caught, not just `firstName`.
  //
  // `street` and `postal` cover streetAddressLine1/2, streetCity, streetRegion,
  // streetPostalCode, streetCountry and their postal twins in one fragment
  // each; `addressline` additionally covers Xero's own `AddressLine1` shape,
  // which carries neither prefix. They also catch a handful of adjacent
  // booleans (`postalSameAsPhysical`, `showGender`, `showOccupation`) whose
  // redaction costs a log reader nothing — the same accepted trade as
  // `emailedAt`, noted on `isSensitiveJsonKey` below.
  //
  // `name` is NOT here, and not in the exact list either. It is the key for
  // lodges, rooms, membership types, email templates, modules, fee schedules
  // and Xero contact groups, and `xero-operation-summaries.ts` reads
  // `defaultGroup.name` and the resulting group names straight out of an
  // already-redacted payload to render the admin Xero operations panel.
  // Redacting every `name` would blank operational logs and live admin UI to
  // catch a person's name that `firstname`/`lastname` catch properly. The three
  // call sites that were logging a person-or-family `name` are fixed at source
  // instead (#2683 problem 3); that is why that half of the issue exists.
  //
  // First names are redacted here with no exception and no opt-out — see
  // INV-PRIV-011 for the single place a first name legitimately survives, and
  // why it is a different module rather than a flag on this one.
  "firstname",
  "lastname",
  "dateofbirth",
  "gender",
  "occupation",
  "street",
  "postal",
  "addressline",
]);
const SENSITIVE_STRING_VALUE_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  // Phone-like digit runs, but only when standalone. The boundaries stop this
  // from matching digits embedded in an alphanumeric identifier (e.g. a cuid
  // such as "cmqdxeu50002101n22w2ivcas", which contains "50002101"). Without
  // them, internal operation/record IDs that happen to hold 8+ consecutive
  // digits were rewritten to "[REDACTED]", corrupting load-bearing IDs stored
  // in persisted payloads (e.g. a requeue's originalOperationId).
  /(?<![A-Za-z0-9])\+?[0-9]{8,15}(?![A-Za-z0-9])/,
];
const STRIPE_SECRET_VALUE_PATTERN =
  /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|(?:pi|seti|si|cs)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+)\b/g;
const TOKEN_QUERY_VALUE_PATTERN =
  /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|payment[_-]?intent[_-]?client[_-]?secret|setup[_-]?intent[_-]?client[_-]?secret|oauth[_-]?state|token|state|code)=)[^&#\s]+/gi;
const TOKEN_KEY_VALUE_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|stripe[_-]?token|token)\s*([:=])\s*("[^"]*"|'[^']*'|[^,\s;&]+)/gi;
const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "access-token",
  "refresh_token",
  "refresh-token",
  "id_token",
  "id-token",
  "client_secret",
  "client-secret",
  "payment_intent_client_secret",
  "payment-intent-client-secret",
  "setup_intent_client_secret",
  "setup-intent-client-secret",
  "oauth_state",
  "oauth-state",
  "token",
  "state",
  "code",
]);

function normalizeJsonKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveJsonKey(key: string) {
  const normalizedKey = normalizeJsonKey(key);

  // Fragment matches may redact noisy keys like emailedAt, which is acceptable to avoid leaking PII or Stripe IDs.
  return (
    SENSITIVE_JSON_KEYS.has(normalizedKey) ||
    Array.from(SENSITIVE_JSON_KEY_FRAGMENTS).some((sensitiveFragment) =>
      normalizedKey.includes(sensitiveFragment)
    )
  );
}

function isSensitiveStringValue(value: string) {
  return SENSITIVE_STRING_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function redactJsonStringCandidate(
  value: string,
  depth: number,
  ancestors: WeakSet<object>
): string | null {
  const trimmed = value.trim();
  const firstBraceIndex = trimmed.search(/[{\[]/);

  if (firstBraceIndex === -1) {
    return null;
  }

  const prefix = trimmed.slice(0, firstBraceIndex);
  const jsonCandidate = trimmed.slice(firstBraceIndex);

  try {
    // The depth is carried into the parsed document rather than reset to zero:
    // a JSON blob embedded in a string embedded in a JSON blob is still nesting,
    // and text and object redaction call each other, so resetting would leave
    // that mutual recursion unbounded again.
    return `${prefix}${JSON.stringify(
      redactSensitiveJsonValue(JSON.parse(jsonCandidate), depth, ancestors)
    )}`;
  } catch {
    return null;
  }
}

// Token-bearing paths can land in webserver, proxy, callbackUrl, and
// observability access logs. Redact both literal paths and URL-encoded callback
// paths so opaque action tokens do not leak through login redirects.
const TOKEN_PATH_PATTERN =
  /(\/(?:membership-cancellation|chores|nominations|pay)\/|\/booking-requests\/(?:verify|respond)\/|\/group-bookings\/join\/verify\/)[A-Za-z0-9_-]+/g;
const ENCODED_TOKEN_PATH_PATTERN =
  /(%2F(?:membership-cancellation|chores|nominations|pay)%2F|%2Fbooking-requests%2F(?:verify|respond)%2F|%2Fgroup-bookings%2Fjoin%2Fverify%2F)[A-Za-z0-9_-]+/gi;

function redactSensitiveTextValue(
  value: string,
  depth: number,
  ancestors: WeakSet<object>
): string {
  const redactedJsonCandidate = redactJsonStringCandidate(
    value,
    depth,
    ancestors
  );
  if (redactedJsonCandidate) {
    return redactedJsonCandidate;
  }

  const redactedValue = value
    .replace(TOKEN_PATH_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(ENCODED_TOKEN_PATH_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(
      /("?(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|stripe[_-]?token|email|phone|phone[_-]?number|mobile[_-]?phone|payment[_-]?method(?:[_-]?id)?|charge(?:[_-]?id)?|client[_-]?reference[_-]?id|first[_-]?name|last[_-]?name|date[_-]?of[_-]?birth|gender|occupation|(?:street|postal)[_-]?[a-z0-9_-]*|address[_-]?line[_-]?[0-9]*)"?\s*:\s*")([^"]*)"/gi,
      `$1${REDACTED_SECRET}"`
    )
    .replace(TOKEN_QUERY_VALUE_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(TOKEN_KEY_VALUE_PATTERN, `$1$2${REDACTED_SECRET}`)
    .replace(STRIPE_SECRET_VALUE_PATTERN, REDACTED_SECRET)
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, `Bearer ${REDACTED_SECRET}`);

  return isSensitiveStringValue(redactedValue) ? REDACTED_SECRET : redactedValue;
}

export function redactSensitiveText(value: string): string {
  return redactSensitiveTextValue(value, 0, new WeakSet<object>());
}

function redactSensitiveJsonValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>
): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    return redactSensitiveTextValue(value, depth, ancestors);
  }

  // Everything that is not an object or array leaves here, so the depth cap
  // below never truncates a scalar — only the structure wrapped around one.
  if (!value || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_REDACTION_DEPTH) {
    return TRUNCATED_BRANCH;
  }

  if (ancestors.has(value)) {
    return CIRCULAR_REFERENCE;
  }

  ancestors.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactSensitiveTextValue(value.message, depth + 1, ancestors),
        stack: value.stack
          ? redactSensitiveTextValue(value.stack, depth + 1, ancestors)
          : undefined,
      };
    }

    if (Array.isArray(value)) {
      return value.map((entry) =>
        redactSensitiveJsonValue(entry, depth + 1, ancestors)
      );
    }

    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      result[key] = isSensitiveJsonKey(key)
        ? REDACTED_SECRET
        : redactSensitiveJsonValue(entryValue, depth + 1, ancestors);
    }

    return result;
  } finally {
    // Removed on the way out so the guard describes the ANCESTOR PATH, not
    // every object visited: two siblings pointing at one shared object are not
    // a cycle and must both render. See MAX_REDACTION_DEPTH above.
    ancestors.delete(value);
  }
}

export function redactSensitiveJson(value: unknown): unknown {
  return redactSensitiveJsonValue(value, 0, new WeakSet<object>());
}

export function redactSensitiveQueryParams(value: unknown): unknown {
  const ancestors = new WeakSet<object>();

  if (typeof value === "string") {
    return redactSensitiveTextValue(value, 0, ancestors);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return redactSensitiveJsonValue(value, 0, ancestors);
  }

  ancestors.add(value);
  try {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        SENSITIVE_QUERY_KEYS.has(key.toLowerCase())
          ? REDACTED_SECRET
          : redactSensitiveJsonValue(entryValue, 1, ancestors),
      ])
    );
  } finally {
    ancestors.delete(value);
  }
}

export function formatRedactedJson(value: unknown): string {
  return JSON.stringify(redactSensitiveJson(value ?? null), null, 2);
}
