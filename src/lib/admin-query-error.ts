/**
 * Why an admin list API refused a query, in words an operator can act on.
 *
 * The admin list routes validate their query string with zod and answer a bad
 * one with `{ error, details: <zod flatten()> }` and a 400. The useful sentence
 * is the FIELD message — "Enter an amount in dollars and cents…", "Amount max
 * must be greater than or equal to amount min" — not the generic `error`.
 *
 * This exists because the payments screen used to run `if (res.ok) { … }` with
 * no `else`: a refused query left the previous query's rows on screen under a
 * filter chip that had never been applied, and the reason was only visible in a
 * network panel (#2685 review). A screen calling this renders what it returns
 * and clears its dataset.
 *
 * Everything about the body is treated as untrusted: a 403, a 500, an HTML error
 * page, or a shape that is not zod's at all falls back to `fallback` rather than
 * showing the operator nothing or a fragment of a stack trace.
 */
export async function readAdminQueryErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return fallback;
  }

  const details = (
    payload as {
      details?: {
        fieldErrors?: Record<string, unknown>;
        formErrors?: unknown;
      };
    } | null
  )?.details;

  const candidates = [
    ...Object.values(details?.fieldErrors ?? {}).flatMap((messages) =>
      Array.isArray(messages) ? messages : [],
    ),
    ...(Array.isArray(details?.formErrors) ? details.formErrors : []),
  ];

  const message = candidates.find(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  );

  return message ?? fallback;
}
