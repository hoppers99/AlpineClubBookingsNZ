/**
 * Runtime validation for raw-SQL result rows (#2289).
 *
 * ## Why this exists
 *
 * `prisma.$queryRaw<SomeType[]>` is an **unchecked cast**. You tell TypeScript
 * what the answer will look like and nothing — not the compiler, not the driver,
 * not a mocked test — ever verifies you were right. Raw SQL returns the
 * **physical** column names; a hand-written type declares whatever the author
 * believed. When those disagree the properties simply arrive `undefined`, and
 * `undefined` is quietly falsy in exactly the comparisons that guard money:
 *
 * ```ts
 * // maxRedemptionsTotal arrived undefined because the column was named
 * // differently in the database than in the type:
 * if (maxRedemptionsTotal !== null && n > maxRedemptionsTotal) reject();
 * //     undefined !== null  -> true       n > undefined -> false
 * // ...so the cap never fired, and nobody saw an error.
 * ```
 *
 * That is not hypothetical: it silently disabled a promo redemption cap and a
 * FREE_NIGHTS discount in a real deployment for months. It is invisible in both
 * of the places anyone looks — the cast silences the compiler, and a mocked
 * Prisma returns whatever shape the test author believed, which is the same
 * wrong belief.
 *
 * The repository's primary answer is structural: take the row lock with
 * `$executeRaw` and read the data through the Prisma model, which knows the real
 * mapping (see `docs/CONCURRENCY_AND_LOCKING.md` -> "Lock raw, read typed"). Use
 * THAT wherever raw SQL was only ever there to obtain a `FOR UPDATE`.
 *
 * This decoder is for the residual: a statement that genuinely has to be raw
 * because Prisma cannot express it (an atomic upsert with `CASE ... RETURNING`,
 * for instance) and whose result is actually read. Validate the rows and a shape
 * mismatch becomes a loud failure on the first request instead of a silent wrong
 * answer forever.
 *
 * ```ts
 * const rows = await prisma.$queryRaw`... RETURNING "count", "resetAt"`;
 * const [row] = decodeRawRows(rows, ROW_SCHEMA, "rate-limit upsert");
 * ```
 *
 * ## What Postgres actually hands back on this stack
 *
 * Getting the type wrong is the trap most likely to be hit next, so the codecs
 * below encode it rather than leaving each call site to rediscover it. Measured
 * against PostgreSQL 16 with Prisma 7 + `@prisma/adapter-pg`:
 *
 * - `int4` / `int2` arrive as a JavaScript **number**.
 * - `COUNT(*)`, `SUM(...)` and any `int8`/`bigint` column arrive as a
 *   **BigInt**. `$queryRaw<{ c: number }[]>` type-checks perfectly and then
 *   throws `Cannot mix BigInt and other types` the first time you do arithmetic
 *   on it — or silently produces a string if you concatenate. Use
 *   {@link rawIntColumn}, which accepts both and narrows to `number`.
 * - `numeric` / `decimal` arrive as a **`Prisma.Decimal` object** — NOT a string
 *   and not a number. Verified in the installed runtime rather than assumed:
 *   `@prisma/client/runtime/client.js` maps the adapter's `Numeric` column type
 *   to `"decimal"` and then deserialises it with `new Decimal(value)`, on the
 *   same code path that turns `int8` into a BigInt and `timestamp` into a Date.
 *   So `z.string()` on a `numeric` column is wrong, and wrong in the way this
 *   whole file exists to catch: it type-checks, a mocked test returns the string
 *   the author believed, and only production disagrees. Nothing in this
 *   repository reads a `numeric` raw, and nothing should — money is integer
 *   cents. {@link rawIntColumn} REFUSES both a `Decimal` object and a numeric
 *   string loudly rather than guessing at either; if a genuine `numeric` read
 *   ever arrives, decode it with a schema that expects the Decimal and convert
 *   deliberately.
 * - `timestamp` / `timestamptz` arrive as a **Date**.
 * - `boolean` arrives as a **boolean**, enums and `text` as **strings**.
 *
 * ## What the failure message may say
 *
 * Column NAMES and TYPES only — never a value. The message travels to logs and
 * to Sentry, and the rows this guards can carry member data. Naming the column
 * and what arrived in it is enough to diagnose every mismatch this class
 * produces (a rename, a dropped column, a widened type); the value adds nothing
 * and would leak.
 */

import { z } from "zod";

/**
 * A raw-SQL statement returned rows that do not match the shape the caller
 * declared. Always a bug in the statement, the schema, or the database — never
 * something to catch and continue from.
 */
export class RawSqlShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawSqlShapeError";
  }
}

/**
 * An integer column, however Postgres chose to send it.
 *
 * Accepts a `number` (`int2`/`int4`) or a `BigInt` (`int8`, and every aggregate
 * — `COUNT(*)` is the one people meet first) and narrows both to `number`.
 * Refuses a float, a BigInt too large to survive the conversion, and anything a
 * `numeric`/`decimal` column sends (a `Prisma.Decimal` object; a string from a
 * driver configured differently), because each of those is a real defect wearing
 * a plausible disguise rather than something to paper over. A column that is
 * genuinely `numeric` is not an integer column, and silently rounding it here
 * would be the money bug this file exists to prevent.
 */
export const rawIntColumn = z
  .union([z.number(), z.bigint()])
  .superRefine((value, ctx) => {
    if (typeof value === "bigint") {
      if (
        value > BigInt(Number.MAX_SAFE_INTEGER) ||
        value < BigInt(Number.MIN_SAFE_INTEGER)
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "bigint outside the safe integer range — converting it to a number would lose precision",
        });
      }
      return;
    }
    if (!Number.isInteger(value)) {
      ctx.addIssue({ code: "custom", message: "expected an integer, got a fractional number" });
    }
  })
  .transform((value) => Number(value));

/** How a received value is described in a failure message: its type, never its content. */
function describeReceived(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined (column absent)";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (typeof value === "object") {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return name && name !== "Object" ? `${name} object` : "object";
  }
  return typeof value;
}

/** The column names actually present on a row, so a rename names itself. */
function describeColumns(row: unknown): string {
  if (row === null || typeof row !== "object") return describeReceived(row);
  const keys = Object.keys(row as Record<string, unknown>).sort();
  return keys.length > 0 ? keys.join(", ") : "(no columns)";
}

/**
 * Validate the rows a raw-SQL statement returned, and return them typed.
 *
 * Throws {@link RawSqlShapeError} — naming `context`, the row index, the
 * offending column and what arrived in it — the moment anything does not match.
 * There is deliberately no lenient mode and no "skip the bad rows": every caller
 * of this helper is reading a value it is about to make a decision with, so a
 * shape it cannot verify must stop the request rather than become a silent
 * `undefined`.
 *
 * Unknown columns are ignored (ordinary `z.object` behaviour) — the failure mode
 * this closes is a MISSING or wrongly-typed column. Pass a `z.strictObject`
 * schema if a call site also wants an unexpected column to be an error.
 *
 * @param rows    whatever the raw call returned — `unknown`, because that is the
 *                honest type once the `$queryRaw<T>` generic is no longer used
 * @param schema  the expected shape of ONE row
 * @param context short human-readable name of the statement, for the message
 *                (e.g. `"rate-limit upsert"`)
 */
export function decodeRawRows<Schema extends z.ZodType>(
  rows: unknown,
  schema: Schema,
  context: string,
): z.output<Schema>[] {
  if (!Array.isArray(rows)) {
    throw new RawSqlShapeError(
      `${context}: expected raw SQL to return an array of rows, got ${describeReceived(rows)}`,
    );
  }

  return rows.map((row, index) => {
    const result = schema.safeParse(row);
    if (result.success) return result.data;

    const problems = result.error.issues
      .map((issue) => {
        const column = issue.path.length > 0 ? issue.path.join(".") : "(row)";
        const received =
          issue.path.length === 1 && row !== null && typeof row === "object"
            ? describeReceived((row as Record<string, unknown>)[String(issue.path[0])])
            : describeReceived(row);
        return `"${column}" (${received}): ${issue.message}`;
      })
      .join("; ");

    throw new RawSqlShapeError(
      `${context}: row ${index} does not match the expected shape — ${problems}. ` +
        `Columns actually returned: ${describeColumns(row)}. ` +
        `Raw SQL returns PHYSICAL column names; check the statement against prisma/schema.prisma (#2289).`,
    );
  });
}
