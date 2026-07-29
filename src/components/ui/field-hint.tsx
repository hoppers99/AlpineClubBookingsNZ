"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/*
  #2257 (D7/D12) — the canonical helper-text primitive.

  Andy's report: "Greyed out text as Example text looks like a field is already
  filled in." A placeholder is grey text INSIDE the control, so an example value
  parked there reads as a value the form already holds — and it vanishes the
  moment the operator types, which is exactly when the example is still wanted.

  The fix is to move examples OUT of the placeholder and render them as helper
  text UNDER the field. Doing that visually is the easy half; the half that gets
  skipped is the ASSISTIVE-TECH half. A `<p>` that merely sits below an input is
  invisible to a screen reader focusing that input — the repo already had four
  competing ad-hoc muted-`<p>` wrappers and only three hand-rolled
  `aria-describedby` pairs to show for it. `FieldHint` + `useFieldHint` make the
  wiring the default rather than the exception:

    const hint = useFieldHint();
    <Label htmlFor="name">Season Name</Label>
    <Input id="name" {...hint.fieldProps} />
    <FieldHint {...hint.hintProps}>Example: Winter 2026</FieldHint>

  `hintProps` carries the generated id and `fieldProps` carries the matching
  `aria-describedby`, so the two halves can only be spread as a pair.

  COEXISTENCE WITH OTHER DESCRIPTIONS. `aria-describedby` is a LIST, and a field
  can legitimately have more than one description — a validation error, a
  view-only explanation (`AdminViewOnlySectionBanner`, #2160), and a hint may all
  apply at once. Pass those ids to `useFieldHint(...)` and they are placed BEFORE
  the hint id: a screen reader reads descriptions in the order the attribute
  lists them, and "this is wrong, and here is why" must be heard before "here is
  an example". Falsy entries are dropped, so a conditional id can be passed
  straight through (`useFieldHint(!canEdit ? viewOnlyReasonId : undefined)`).

  `id` is REQUIRED on `FieldHint` rather than optional-with-a-fallback. An
  unassociated hint is the exact defect this component exists to remove, so the
  type system refuses to compile one. Sites that render hints inside a `.map()`
  cannot call a hook per row; they pass a deterministic id instead (see
  `finance-report-mappings-panel.tsx`, `club-identity-panel.tsx`).
*/

export type FieldHintProps = Omit<React.ComponentPropsWithoutRef<"p">, "id"> & {
  /** Required: the id `aria-describedby` on the described control points at. */
  id: string;
};

const FieldHint = React.forwardRef<HTMLParagraphElement, FieldHintProps>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("text-xs leading-5 text-muted-foreground", className)}
      {...props}
    />
  ),
);
FieldHint.displayName = "FieldHint";

/**
 * Generate a hint id and the `aria-describedby` that points at it.
 *
 * @param precedingIds ids of descriptions that must be announced BEFORE the
 *   hint — a field error first of all. Falsy entries are ignored.
 */
function useFieldHint(...precedingIds: Array<string | false | null | undefined>): {
  /** Spread onto the input / textarea / select the hint describes. */
  fieldProps: { "aria-describedby": string };
  /** Spread onto the `<FieldHint>` element. */
  hintProps: { id: string };
} {
  const hintId = React.useId();
  const preceding = precedingIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );

  return {
    fieldProps: {
      "aria-describedby": [...preceding, hintId].join(" "),
    },
    hintProps: { id: hintId },
  };
}

/**
 * The `aria-describedby` value for a hint whose id is supplied by the caller
 * rather than by {@link useFieldHint} — the `.map()` case, where a hook cannot
 * be called per row. Same ordering contract: `precedingIds` are announced first.
 */
function describedByFieldHint(
  hintId: string,
  ...precedingIds: Array<string | false | null | undefined>
): string {
  return [
    ...precedingIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
    hintId,
  ].join(" ");
}

export { FieldHint, useFieldHint, describedByFieldHint };
