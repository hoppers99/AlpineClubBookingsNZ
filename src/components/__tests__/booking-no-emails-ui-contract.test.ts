import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  #2259 (owner decision D10) — the two invariants the "No emails" UI must never
  break, checked structurally rather than by review.

  1. A MEMBER MUST NEVER LEARN THE SWITCH EXISTS. The booking detail page serves
     members and admins from one file, so the control, the banner, and every
     `noEmails` value it produces have to sit behind an admin predicate. Not
     only the render: props are serialised into client-component RSC payloads,
     so a prop threaded unconditionally leaks the switch on the wire even when
     nothing draws it.

  2. THE HONESTY RULE. While the switch is on, no per-action prompt may offer to
     email the member. The mailer withholds the message either way, so offering
     the choice invites the admin to pick "…and email member" and walk away
     believing the member was told — the exact false belief D10's acknowledgement
     exists as the compensating control for.

  Both run over the TypeScript AST rather than over file text, for the reason
  `view-only-banner-contract.test.ts` had to learn twice: raw text cannot tell a
  call site from prose about a call site, and every file here carries comments
  quoting the very expressions being matched.
*/

const SRC = join(process.cwd(), "src");

const BOOKING_PAGE = join(
  SRC,
  "app",
  "(authenticated)",
  "bookings",
  "[id]",
  "page.tsx",
);

/**
 * Admin predicates the booking page may gate on. `canSeeAdminTools` is the
 * page's own "Full Admin or Booking Officer" gate; the role comparison is what
 * the cancel and modify routes themselves resolve before honouring
 * `notifyMember`, so a value gated on it can only reach a viewer the server
 * already treats as an admin.
 */
const ADMIN_GATES = [
  /\bcanSeeAdminTools\b/,
  /viewerAuthorizationRole\s*===/,
  /\bnoEmailsState\b/,
];

/**
 * Every surface that offers a per-action "email the member?" choice about a
 * BOOKING, and therefore has to drop that choice while the switch is on.
 *
 * The closed-world assertion below is what keeps this list honest: the set of
 * files mentioning `notifyMember` must be exactly this list plus the
 * deliberately-excluded one, so a NEW notify prompt anywhere forces a decision
 * about the switch instead of silently escaping the rule.
 */
const BOOKING_NOTIFY_PROMPTS = [
  "components/admin/confirm-pending-guests-button.tsx",
  "components/cancel-booking-button.tsx",
  "components/edit-booking-panel.tsx",
  "components/admin/booking-requests/booking-approvals-panel.tsx",
  "app/(admin)/admin/waitlist/page.tsx",
  "app/(admin)/admin/refund-requests/page.tsx",
];

/**
 * Surveyed and deliberately NOT changed, each with the reason it is out of
 * scope. Written down here rather than in a commit message, because the next
 * person's question is "was this one missed?" and the answer has to be
 * checkable.
 */
const NOT_BOOKING_BOUND: Record<string, string> = {
  // A booking that does not exist yet cannot carry the switch.
  "app/(admin)/admin/book/page.tsx":
    "creates a NEW booking; there is nothing silenced yet",
  // BookingRequest, not Booking. Its templates are explicitly excluded from
  // ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES for the same reason.
  "components/admin/booking-requests/public-booking-requests-panel.tsx":
    "declines a public BookingRequest before any Booking row exists",
  // Membership / account / family lifecycle: keyed on a member, not a booking.
  // The switch is deliberately booking-keyed and never address-keyed, so it
  // does not and must not reach these.
  "app/(admin)/admin/membership-cancellations/page.tsx":
    "membership-scoped: reviews cancellation participants, not a booking",
  "app/(admin)/admin/member-applications/page.tsx":
    "membership application review, not a booking",
  "app/(admin)/admin/deletion-requests/deletion-requests-client.tsx":
    "account deletion (privacy) request, not a booking",
  "app/(admin)/admin/members/[id]/_components/member-lifecycle-card.tsx":
    "member archive/delete lifecycle, not a booking",
  "app/(admin)/admin/members/[id]/_components/member-partner-link-card.tsx":
    "member partner link, not a booking",
  "components/admin/family-groups/request-review-section.tsx":
    "family group request review, not a booking",
  // The one genuinely awkward case. The roster send is per DATE and fans out
  // across every booking staying that night, so it is not one booking's choice
  // to suppress: silencing the prompt would misdescribe what happens to the
  // OTHER bookings' guests, who are still emailed. A silenced booking's own
  // `chore-roster` mail is already withheld by the mailer's gate, which is
  // where a multi-booking send has to be handled.
  "app/(admin)/admin/roster/page.tsx":
    "per-date roster send fanning out across many bookings; the mailer's gate silences each one individually",
};

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
}

function eachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  visit(root);
  root.forEachChild((child) => eachNode(child, visit));
}

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function isJsxTag(node: ts.Node): node is JsxTag {
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
}

function lineOf(ast: ts.SourceFile, node: ts.Node): number {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
}

/**
 * The text of every condition `node` is rendered under: the test of each
 * enclosing `? :`, the left operand of each enclosing `&&`, and the condition
 * of each enclosing `if`. This is what "is it gated" means for a render site —
 * it is only reached when all of them hold, so matching ANY of them is the
 * correct (and conservative) reading of "gated on".
 */
function guardTexts(ast: ts.SourceFile, node: ts.Node): string[] {
  const out: string[] = [];
  let cur: ts.Node = node;
  while (cur.parent) {
    const parent = cur.parent;
    if (ts.isConditionalExpression(parent) && parent.condition !== cur) {
      out.push(parent.condition.getText(ast));
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === cur
    ) {
      out.push(parent.left.getText(ast));
    }
    if (ts.isIfStatement(parent) && parent.thenStatement === cur) {
      out.push(parent.expression.getText(ast));
    }
    cur = parent;
  }
  return out;
}

function jsxTagsNamed(ast: ts.SourceFile, name: string): JsxTag[] {
  const out: JsxTag[] = [];
  eachNode(ast, (node) => {
    if (isJsxTag(node) && node.tagName.getText(ast) === name) out.push(node);
  });
  return out;
}

/** Every `.tsx` source file under `src`, excluding tests. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (
      entry.name.endsWith(".tsx") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("No emails UI is admin-only (#2259)", () => {
  const ast = parse(BOOKING_PAGE);

  it("finds the surface it is meant to police", () => {
    // Guards against a tree move making every assertion below vacuous.
    expect(
      ast.getFullText().length,
      "booking detail page not found or empty",
    ).toBeGreaterThan(1000);
    expect(ast.getFullText()).toContain("BookingWithheldEmailsBanner");
  });

  it("proves the indirection it accepts as a gate", () => {
    /*
      `noEmailsState` counts as an admin gate below because it is null for
      anyone who is not an admin. That is only true while its DECLARATION says
      so, and nothing else in this suite would notice if it stopped — every
      render site would keep passing while quietly gating on nothing. So the
      declaration is checked here, once, and the indirection is earned rather
      than assumed.
    */
    const declarations: ts.VariableDeclaration[] = [];
    eachNode(ast, (node) => {
      if (!ts.isVariableDeclaration(node)) return;
      if (node.name.getText(ast) !== "noEmailsState") return;
      declarations.push(node);
    });
    expect(declarations, "noEmailsState is not declared here").toHaveLength(1);

    const initializer = declarations[0].initializer?.getText(ast) ?? "";
    expect(
      /\bcanSeeAdminTools\b/.test(initializer),
      `noEmailsState is treated as an admin gate throughout this suite. Its ` +
        `declaration must derive from canSeeAdminTools, or every render site ` +
        `gated on it is gated on nothing.`,
    ).toBe(true);
    // …and it must actually be ABSENT for a non-admin, not merely different.
    expect(initializer).toMatch(/:\s*null/);
  });

  it("renders the withheld-emails banner only behind the admin gate", () => {
    const sites = jsxTagsNamed(ast, "BookingWithheldEmailsBanner");
    expect(sites.length, "the banner is never rendered").toBeGreaterThan(0);

    const offenders = sites
      .filter(
        (site) =>
          !guardTexts(ast, site).some((guard) =>
            ADMIN_GATES.some((gate) => gate.test(guard)),
          ),
      )
      .map((site) => `page.tsx:${lineOf(ast, site)}`);

    expect(
      offenders,
      `The booking detail page serves MEMBERS as well as admins. A ` +
        `withheld-emails banner rendered outside the admin gate tells a ` +
        `member the "No emails" switch exists — the one thing #2258/#2259 ` +
        `must never do.`,
    ).toEqual([]);
  });

  it("renders the switch itself only behind the admin gate", () => {
    // The control lives inside AdminBookingToolsCard, which is itself gated;
    // the state it needs is produced here, so the production is what is checked.
    const sites = jsxTagsNamed(ast, "AdminBookingToolsCard");
    expect(sites.length).toBeGreaterThan(0);
    const offenders = sites
      .filter(
        (site) =>
          !guardTexts(ast, site).some((guard) =>
            ADMIN_GATES.some((gate) => gate.test(guard)),
          ),
      )
      .map((site) => `page.tsx:${lineOf(ast, site)}`);
    expect(offenders).toEqual([]);
  });

  it("never hands a member the switch state on the wire", () => {
    /*
      Every `noEmails` value the page produces has to be gated, whether it is
      drawn or not: the booking editor data and the cancel button's prop are
      serialised into client-component payloads a member can read.
    */
    const offenders: string[] = [];

    // JSX props named `noEmails`.
    eachNode(ast, (node) => {
      if (!isJsxTag(node)) return;
      for (const prop of node.attributes.properties) {
        if (!ts.isJsxAttribute(prop)) continue;
        if (prop.name.getText(ast) !== "noEmails") continue;
        const text = prop.initializer?.getText(ast) ?? "";
        const gated =
          ADMIN_GATES.some((gate) => gate.test(text)) ||
          guardTexts(ast, node).some((guard) =>
            ADMIN_GATES.some((gate) => gate.test(guard)),
          );
        if (!gated) {
          offenders.push(
            `page.tsx:${lineOf(ast, prop)} noEmails=${text} on <${node.tagName.getText(ast)}>`,
          );
        }
      }
    });

    // Object properties named `noEmails` — the booking editor data literal, and
    // the admin-only state object. Either the value itself carries the gate or
    // the whole object literal is built under one.
    let propertiesSeen = 0;
    eachNode(ast, (node) => {
      if (!ts.isPropertyAssignment(node)) return;
      if (node.name.getText(ast) !== "noEmails") return;
      propertiesSeen += 1;
      const text = node.initializer.getText(ast);
      const gated =
        ADMIN_GATES.some((gate) => gate.test(text)) ||
        guardTexts(ast, node).some((guard) =>
          ADMIN_GATES.some((gate) => gate.test(guard)),
        );
      if (!gated) {
        offenders.push(`page.tsx:${lineOf(ast, node)} noEmails: ${text}`);
      }
    });

    expect(
      propertiesSeen,
      "no `noEmails` value is produced here at all; the check has gone blind",
    ).toBeGreaterThan(0);
    expect(
      offenders,
      `These produce the booking's "No emails" state without an admin ` +
        `predicate. Even an undrawn prop is serialised into the RSC payload, ` +
        `so a member could read the switch's existence off the wire.`,
    ).toEqual([]);
  });

  it("does not even query the withheld list for a member", () => {
    const calls: ts.CallExpression[] = [];
    eachNode(ast, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === "getWithheldBookingEmails"
      ) {
        calls.push(node);
      }
    });
    expect(calls.length, "the withheld list is never read").toBeGreaterThan(0);

    const offenders = calls
      .filter(
        (call) =>
          !guardTexts(ast, call).some((guard) =>
            ADMIN_GATES.some((gate) => gate.test(guard)),
          ),
      )
      .map((call) => `page.tsx:${lineOf(ast, call)}`);

    expect(
      offenders,
      `Reading the withheld list for a member puts withheld subjects one ` +
        `careless prop away from their screen. Query it only behind the gate.`,
    ).toEqual([]);
  });
});

describe("No emails honesty rule (#2259)", () => {
  it("accounts for every notify-member prompt in the repo", () => {
    /*
      The closed world. A new "email the member?" prompt must be classified —
      booking-bound (and therefore subject to the rule) or not — rather than
      quietly joining neither list.
    */
    const found = sourceFiles()
      .filter((file) =>
        /\bnotifyMember\b|\bnotifyRequester\b/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(SRC, file).split(sep).join("/"));

    expect(found.length).toBeGreaterThan(10);
    expect(
      found.sort(),
      `A surface that asks "email the member?" is either about a BOOKING — ` +
        `and must drop the choice while the switch is on — or it is not. Add ` +
        `it to BOOKING_NOTIFY_PROMPTS or to NOT_BOOKING_BOUND with the reason.`,
    ).toEqual(
      [...BOOKING_NOTIFY_PROMPTS, ...Object.keys(NOT_BOOKING_BOUND)].sort(),
    );
  });

  it("offers no email choice on a silenced booking", () => {
    /*
      For each booking-bound prompt: every affirmative "…and email member"
      action must render under a negated `noEmails` guard. Re-offer the choice
      with the switch on — delete the guard — and this fails, which is the point.

      Both spellings of a button label are collected: JSX text
      (`>Save and email member<`) and a string literal inside a JSX expression
      (the `decision === "REJECTED" ? … : …` labels the review queues use). A
      check that saw only the first would be silently vacuous on two of the six.
    */
    const offenders: string[] = [];

    for (const rel of BOOKING_NOTIFY_PROMPTS) {
      const file = join(SRC, ...rel.split("/"));
      const ast = parse(file);

      // The shared note has to be reachable at all.
      if (!ast.getFullText().includes("BookingNoEmailsNotice")) {
        offenders.push(`${rel} never renders <BookingNoEmailsNotice>`);
      }

      const affirmatives: ts.Node[] = [];
      eachNode(ast, (node) => {
        if (ts.isJsxText(node)) {
          if (/and email member/i.test(node.getText(ast))) affirmatives.push(node);
          return;
        }
        // A string literal only counts inside JSX — a toast or an audit string
        // is not an offered choice.
        if (!ts.isStringLiteral(node)) return;
        if (!/and email member/i.test(node.text)) return;
        let cur: ts.Node | undefined = node.parent;
        while (cur) {
          if (ts.isJsxExpression(cur)) {
            affirmatives.push(node);
            return;
          }
          cur = cur.parent;
        }
      });

      if (affirmatives.length === 0) {
        offenders.push(`${rel} has no "…and email member" action to police`);
        continue;
      }

      for (const node of affirmatives) {
        const guarded = guardTexts(ast, node).some(
          (guard) => guard.trimStart().startsWith("!") && /noEmails/i.test(guard),
        );
        if (!guarded) {
          offenders.push(
            `${rel}:${lineOf(ast, node)} offers "…and email member" with no negated noEmails guard`,
          );
        }
      }
    }

    expect(
      offenders,
      `While the "No emails" switch is on, the mailer withholds the message ` +
        `whichever button the admin presses. Offering the choice therefore ` +
        `invites a false belief that the member was told — the exact harm ` +
        `D10's acknowledgement is the compensating control for.`,
    ).toEqual([]);
  });
});
