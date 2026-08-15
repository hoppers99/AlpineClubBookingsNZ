"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * The ONE way a lodge-scoped surface says its lodge list did not load (#2701).
 *
 * Every admin lodge selector draws its options from `useLodgeOptions`, and
 * until #2701 a failed request produced `lodges: []` — indistinguishable from a
 * club that genuinely has no lodges. `LodgeSelect` renders nothing below two
 * lodges (ADR-002), so the selector simply vanished and the page read as a
 * single-lodge club. That is not a cosmetic problem: the selection normalises
 * to `null`, and a `null` lodge is resolved server-side to the club's DEFAULT
 * lodge, so the next thing the operator saved landed on a lodge they were never
 * shown.
 *
 * This exists so twenty surfaces share one explanation and one retry rather
 * than twenty variants of an empty dropdown. Deliberately small: it says what
 * is missing and offers the retry. Deciding what ELSE to suppress — which is
 * the half that actually prevents the wrong write — belongs to each page,
 * because only the page knows which of its controls are lodge-scoped.
 *
 * `forbidden` is not an error and must never be dressed up as one. A role that
 * holds `bookings` but not `lodge:view` (shipped `ADMIN_MEMBERSHIP` and
 * `FINANCE_ADMIN`) gets a 403 as its NORMAL answer, and a retry could only
 * refuse again.
 */
export function LodgeOptionsUnavailableNotice({
  failed,
  forbidden,
  onRetry,
  what,
  className,
}: {
  /** The lodge list request failed — transport, 500, anything but a 403. */
  failed: boolean;
  /** The lodge list was refused (403). A permissions fact, not an outage. */
  forbidden?: boolean;
  onRetry: () => void;
  /**
   * What this surface cannot show or change without a lodge, in the operator's
   * own words and lower case — "chore assignments", "this lodge's rooms and
   * beds". Written into both messages so the notice explains THIS page rather
   * than lodges in the abstract.
   */
  what: string;
  className?: string;
}) {
  if (forbidden) {
    return (
      <Alert variant="info" title="Your role cannot choose a lodge" className={className}>
        Viewing lodges needs lodge access, which your admin role does not have,
        so {what} cannot be shown per lodge here. Ask for lodge access if you
        need it — nothing has failed.
      </Alert>
    );
  }

  if (!failed) return null;

  return (
    <Alert
      variant="error"
      title="The lodge list could not be loaded"
      className={className}
    >
      <p className="mb-3">
        {what} cannot be shown or changed, because we do not know which lodge
        they belong to. This is a failure to load, <strong>not</strong> a club
        with no lodges — nothing has been deleted, and nothing here is safe to
        save until the list returns.
      </p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </Alert>
  );
}
