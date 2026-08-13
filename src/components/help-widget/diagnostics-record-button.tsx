"use client";

import { Stethoscope } from "lucide-react";

import { useDiagnosticsRecord } from "./help-widget-context";

/**
 * "Ask diagnostics about this one" — the control that gives an investigation its
 * SUBJECT (AID-7, #2378, owner decision D11, 13 Aug 2026).
 *
 * WHY IT EXISTS. The page-context registry declares a `recordKind` on the bookings,
 * waitlist and payments lists, but a list does not say WHICH row the operator means,
 * and there is no `/admin/bookings/[id]` page in this codebase — admin rows link out
 * to the member-facing `/bookings/{id}`, which is not an admin route and is not in the
 * registry. Only `/admin/members/[id]` names its record in the address. Without this
 * control the product could not be asked its own headline question, "why will this
 * booking not confirm?".
 *
 * WHY IT IS A ROW CONTROL AND NOT A SEARCH BOX. This was the owner's choice between
 * three options, and the reason it won is that it adds NO NEW WAY TO REACH A RECORD.
 * The operator picks something already on their screen, rendered by a page whose own
 * guard already checked `bookings:view` or `finance:view`. A picker inside the panel —
 * paste a reference, or search — would be a genuinely new reach, and a paste field
 * that distinguishes "not found" from "not authorised" is precisely the existence
 * oracle #2378 rules out.
 *
 * IT SENDS AN ID AND NOTHING ELSE. Not the kind, not a field, not the label rendered
 * beside it. The kind comes from the route the SERVER matches, and the record is
 * re-resolved server-side under the operator's own authority before a field is read,
 * so the worst a wrong id can do is select a record the server refuses.
 *
 * IT HIDES ITSELF WHEN DIAGNOSTICS IS NOT AVAILABLE, off the widget's own published
 * answer rather than a permission check of its own — see
 * `usePublishDiagnosticsAvailable`. Three list pages each re-deriving "may this admin
 * use Diagnostics, and is the module on?" is three chances to get it wrong; this way
 * the control and the Diagnostics tab appear and disappear together.
 */
export function DiagnosticsRecordButton({
  recordId,
  subject,
}: {
  recordId: string;
  /**
   * What the operator would call this row — "booking BK-1042", "the payment from
   * J. Smith". It is the ACCESSIBLE NAME only and never leaves the browser: a row of
   * identical "Ask diagnostics" buttons is unusable with a screen reader, which is
   * the accessibility requirement #2378 sets for the evidence-heavy surfaces.
   */
  subject: string;
}) {
  const { available, select } = useDiagnosticsRecord();

  // Rendered by server components that know nothing about permissions, so the answer
  // arrives from the widget after mount. Absent is the correct first paint: a control
  // that flashes in and vanishes is worse than one that appears a frame late.
  if (!available) return null;

  return (
    <button
      type="button"
      onClick={() => select(recordId)}
      data-testid="diagnostics-record-button"
      title={`Ask diagnostics about ${subject}`}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Stethoscope aria-hidden="true" className="h-4 w-4" />
      <span className="sr-only">Ask diagnostics about {subject}</span>
    </button>
  );
}
