import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  THE ORDER THESE HOOKS ARE CALLED IN IS PART OF THE BEHAVIOUR.

  React registers effects in the order their hooks run, and runs them in that
  same order after a commit. The monolith this folder was extracted from had
  eight effects in one file, so their order was whatever the file said and no
  reviewer had to think about it. Now they live in ten hooks called from a
  shell, and moving one call up a line silently reorders the effects.

  This is not hypothetical. The split got E6 wrong once and needed a dedicated
  commit — "restore E6 to its original position in the effect order" — to put
  it back, and nothing would have caught it.

  Two hooks exist ONLY to hold this order. `useModificationQuoteState` and
  `usePromoSelectionState` own state with no effect, deliberately separated
  from `useDebouncedModificationQuote` (E4) and `usePromoBeneficiaryReset` (E6)
  so the effects can sit at their original positions rather than being dragged
  up next to the state they touch. That separation looks like indirection for
  its own sake right up until someone "tidies" it away, which is exactly the
  reorder this test refuses.

  WHY A SOURCE-ORDER ASSERTION RATHER THAN A BEHAVIOURAL ONE. Effect
  registration order IS a source property — it is the order the hook calls
  appear in the component body, and nothing else. A behavioural test cannot
  reach it: within a single commit React captures each effect's dependencies at
  render time and batches the resulting state updates, and no two of these
  eight write the same ref or the same state slot, so a same-commit reorder is
  inert *today*. The risk is that it stops being inert once someone adds a
  ninth effect that does share state with one of them — and by then the
  ordering has already drifted. Pinning the property directly is the honest
  way to hold something whose breakage is latent rather than immediate.

  If you are adding a hook: add it to the list below at the position you
  intend, and say in the PR why that position is right.
*/

const PANEL = join(process.cwd(), "src", "components", "edit-booking-panel.tsx");

/**
 * The hooks whose relative order is load-bearing, in the order the original
 * monolith registered their effects (E1 through E8, with the two state-only
 * hooks at the positions that keep E4 and E6 where they were).
 */
const ORDERED_HOOKS = [
  "useBookingFamilyOptions", // E1 — load the booking owner's family
  "useAvailablePromoCodes", // E2 — load promo codes available to the viewer
  "useModificationQuoteState", // state only; splits E4 away from its state
  "useGuestDateModes", // E3 — reset per-guest dates when no longer offered
  "usePromoSelectionState", // state only; splits E6 away from its state
  "useDebouncedModificationQuote", // E4 — price the pending edit, debounced
  "useMemberGuestFinder", // E5 — re-open on a refused member-guest add
  "usePromoBeneficiaryReset", // E6 — retire a promo whose beneficiary left
  "useReviewJustificationLatch", // E7 — latch the review-justification field
  "useHostingCoverageOverride", // E8 — retire a stale hosting override
] as const;

/** Every call expression in the file, in source order, by callee name. */
function calleeNamesInSourceOrder(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      names.push(node.expression.text);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return names;
}

describe("the edit-booking panel registers its effects in the original order", () => {
  const called = calleeNamesInSourceOrder(PANEL);

  it("calls every ordered hook exactly once, so the list is not stale", () => {
    // A hook that has been renamed or removed makes the order assertion below
    // pass vacuously on a shorter list. Fail loudly here instead.
    const missing = ORDERED_HOOKS.filter((hook) => !called.includes(hook));
    expect(
      missing,
      "these hooks are named in the ordering contract but are not called by " +
        "the panel. If one was renamed or removed, update ORDERED_HOOKS in " +
        "this file and say in the PR why the new order is right.",
    ).toEqual([]);

    for (const hook of ORDERED_HOOKS) {
      expect(
        called.filter((name) => name === hook),
        `${hook} is called more than once; the ordering contract assumes one ` +
          "call site per hook",
      ).toHaveLength(1);
    }
  });

  it("calls them in the order the monolith registered their effects", () => {
    const actual = called.filter((name) =>
      (ORDERED_HOOKS as readonly string[]).includes(name),
    );

    expect(
      actual,
      "the effect hooks are called in a different order than the monolith " +
        "registered them, which reorders the effects React runs after every " +
        "commit. This split already got it wrong once (E6). If the new order " +
        "is deliberate, change ORDERED_HOOKS and justify it in the PR.",
    ).toEqual([...ORDERED_HOOKS]);
  });
});
