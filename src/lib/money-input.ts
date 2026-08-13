/**
 * The canonical boundary for money a PERSON typed (INV-MONEY-001, INV-MONEY-003).
 *
 * Everything a member or an admin types into a dollars box comes through here.
 * The parse is exact: the dollar and cent digit groups are read as integers and
 * combined with integer arithmetic, so the amount never passes through a binary
 * float and no decimal fraction is ever approximated. A string that is not a
 * well-formed amount returns `null` — it never becomes `0`, and callers must
 * turn that `null` into a validation error the person can see (#2685).
 *
 * Already-numeric amounts from an accounting provider are a DIFFERENT boundary:
 * the decimal source text no longer exists by the time they arrive, so they go
 * through `@/lib/money-provider-amount` instead. Do not send them here.
 */

/** Parse a non-negative decimal NZD input exactly, without binary float math. */
export function parseDecimalDollarsToCents(value: string): number | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(dollars)) return null;
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) && total <= 2_147_483_647 ? total : null;
}

/**
 * Parse a decimal NZD input that may carry a leading sign, exactly.
 *
 * Only for the places where the domain genuinely allows a negative amount — a
 * member credit adjustment can be a debit. The magnitude is handed to
 * `parseDecimalDollarsToCents`, so grammar, cent precision and range are the
 * canonical rules and this adds nothing but the sign. It is deliberately NOT the
 * default: a price, fee or refund box that accepts a minus sign is a bug.
 */
export function parseSignedDecimalDollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const magnitude =
    negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const cents = parseDecimalDollarsToCents(magnitude);
  if (cents === null) return null;
  // `-0` is not a distinct amount; keep zero canonical so callers can compare it.
  return negative && cents !== 0 ? -cents : cents;
}
