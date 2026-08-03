import { AGE_UNAVAILABLE_LABEL } from "@/lib/member-age";
import { cn } from "@/lib/utils";

/**
 * The calculated-age display for identity-sensitive Family Group workflows
 * (#2568). Used only where an authorised membership administrator is confirming
 * WHICH member record a link, approval, creation, edit or removal applies to —
 * never on the ordinary Family Group overview, a routine member pill, or any
 * member-facing or public surface.
 *
 * The label is always the finished string the server calculated
 * (`formatMemberIdentityAge`), including "Age unavailable"; the browser is never
 * sent a date of birth to work it out from.
 *
 * Presentation rules this component exists to guarantee:
 *
 * - **Always visible, never hover-only.** No `title`, no tooltip: the review
 *   workflow has to be usable on a touch device and by a keyboard-only admin.
 * - **Announced as an age.** The visually-hidden prefix means a screen reader
 *   reads "Age 47 years" rather than a bare number next to a name.
 * - **Mobile and long-name safe.** The value itself never breaks mid-way
 *   (`whitespace-nowrap`), while every row that hosts it wraps around it, so a
 *   long name pushes the age onto the next line instead of colliding with it.
 * - **No stutter on the unavailable sentinel.** Both presentations put the word
 *   "Age" in front of the value — visibly in the line, for a screen reader in
 *   the chip. `Age unavailable` already begins with it, so the prefix is dropped
 *   for that one value; otherwise a member with no recorded date of birth read
 *   "Age: Age unavailable" and was announced "Age Age unavailable". The label
 *   text itself is never rewritten: the owner specification fixes it as
 *   `Age unavailable`.
 */

/** Whether this label already reads as its own sentence ("Age unavailable"). */
function labelCarriesItsOwnAgePrefix(ageLabel: string) {
  return ageLabel === AGE_UNAVAILABLE_LABEL;
}

export function MemberAgeChip({
  ageLabel,
  className,
}: {
  ageLabel: string | null | undefined;
  className?: string;
}) {
  // Absent field (an older cached payload, or a surface that deliberately does
  // not carry the age) renders nothing at all — never an empty chip.
  if (!ageLabel) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground",
        className
      )}
    >
      {labelCarriesItsOwnAgePrefix(ageLabel) ? null : (
        <span className="sr-only">Age </span>
      )}
      {ageLabel}
    </span>
  );
}

/**
 * The same age value as a labelled line, for the confirmation panels that read
 * as prose rather than as a chip row. Wrapped in its own block so it sits on its
 * own line on a narrow screen.
 */
export function MemberAgeLine({
  ageLabel,
  className,
}: {
  ageLabel: string | null | undefined;
  className?: string;
}) {
  if (!ageLabel) return null;

  return (
    <span className={cn("block", className)}>
      {labelCarriesItsOwnAgePrefix(ageLabel) ? null : "Age: "}
      <span className="whitespace-nowrap font-medium text-foreground">{ageLabel}</span>
    </span>
  );
}
