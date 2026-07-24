/**
 * Escape a single value for RFC 4180 CSV output.
 *
 * Wraps the value in double-quotes when it contains a comma, a double-quote, a
 * newline, or a carriage return, doubling any embedded quotes. Also guards
 * against CSV/formula injection: values whose first character could be
 * interpreted as a formula by a spreadsheet (`=`, `+`, `-`, `@`, tab, or CR)
 * are prefixed with a single quote before the RFC-4180 quoting logic runs.
 *
 * This is a pure string helper with no server-only dependencies, so it is safe
 * to import from both client components (browser-side CSV exports) and server
 * route handlers. It is the single source of truth for CSV cell escaping — new
 * call sites must delegate here rather than re-implementing the guard.
 */
export function escapeCsvCell(value: string): string {
  const firstChar = value.charAt(0);
  if (
    firstChar === "=" ||
    firstChar === "+" ||
    firstChar === "-" ||
    firstChar === "@" ||
    firstChar === "\t" ||
    firstChar === "\r"
  ) {
    value = "'" + value;
  }
  if (
    value.includes('"') ||
    value.includes(",") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
