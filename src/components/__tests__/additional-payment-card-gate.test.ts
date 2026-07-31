import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  #2350 round 2 — the member's "pay this extra" card must not appear on a
  booking whose lifecycle can no longer collect money.

  Cancelling a booking marks the additional intent FAILED and leaves
  `additionalAmountCents` exactly as it was, and the cancel path asks Stripe to
  cancel only an intent that was still OUTSTANDING — one that had already failed
  (a declined card) stays confirmable at Stripe. So while the card's condition
  was amount-and-status only, the owner of a cancelled booking was shown a
  payment form, the secret route behind it handed out a live client secret, and
  a retry with a good card went through. The late-capture backstop (#1350)
  auto-refunds and alerts, but the member had still been charged for a booking
  that no longer existed.

  Checked over the TypeScript AST rather than the file text, for the reason
  `booking-no-emails-ui-contract.test.ts` had to learn twice: the page carries
  comments quoting the very expressions being matched, and raw text cannot tell
  a call site from prose about one.
*/

const BOOKING_PAGE = join(
  process.cwd(),
  "src",
  "app",
  "(authenticated)",
  "bookings",
  "[id]",
  "page.tsx",
);

const SECRET_ROUTE = join(
  process.cwd(),
  "src",
  "app",
  "api",
  "bookings",
  "[id]",
  "additional-payment-secret",
  "route.ts",
);

function parse(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function findFirst(
  node: ts.Node,
  predicate: (candidate: ts.Node) => boolean,
): ts.Node | null {
  if (predicate(node)) return node;
  for (const child of node.getChildren()) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

function callsFunction(node: ts.Node, name: string): boolean {
  return (
    findFirst(
      node,
      (candidate) =>
        ts.isCallExpression(candidate) &&
        ts.isIdentifier(candidate.expression) &&
        candidate.expression.text === name,
    ) !== null
  );
}

describe("the member's additional-payment card", () => {
  it("renders only for a lifecycle that can still collect the money", () => {
    const source = parse(BOOKING_PAGE);

    const card = findFirst(source, (node) => {
      const tag = ts.isJsxSelfClosingElement(node)
        ? node.tagName
        : ts.isJsxOpeningElement(node)
          ? node.tagName
          : null;
      return tag != null && tag.getText() === "AdditionalPaymentCard";
    });
    expect(card, "AdditionalPaymentCard is no longer on the booking page").not.toBeNull();

    // The `{...}` container the card is rendered from: its expression is the
    // whole guard, and it holds no comment trivia, so this is code only.
    let container: ts.Node | undefined = card ?? undefined;
    while (container && !ts.isJsxExpression(container)) {
      container = container.parent;
    }
    expect(container, "the card is not inside a JSX expression guard").toBeDefined();

    const guard = (container as ts.JsxExpression).expression;
    expect(guard).toBeDefined();
    expect(callsFunction(guard!, "isAdditionalPayableBookingStatus")).toBe(true);
  });

  it("is gated by the same predicate as the route that hands out the secret", () => {
    const route = parse(SECRET_ROUTE);
    expect(callsFunction(route, "isAdditionalPayableBookingStatus")).toBe(true);
  });
});
