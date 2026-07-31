import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  #2354 — the admin member page must decide "may this membership be cancelled?"
  with the same question the server asks, never with a permissions question.

  The bug this pins: the page gated the action on `hasAccessRole(member,
  "USER")`. Access roles are deliberately cleared for anyone who cannot log in
  (`normalizeAssignableAccessRoles`), so every family dependant and every
  non-login adult resolved to zero roles and the cancel action vanished — while
  `createAdminMembershipCancellationRequest` accepted exactly those members.

  Unit tests over the helper cannot catch a regression here: restoring the old
  expression on the page leaves the helper, and its tests, untouched and green.
  So the call site itself is the thing asserted, structurally over the AST
  rather than over file text, because this file quotes the very identifiers
  being matched.
*/

const PAGE = join(
  process.cwd(),
  "src",
  "app",
  "(admin)",
  "admin",
  "members",
  "[id]",
  "page.tsx",
);

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

/** The initialiser of `const <name> = …`, as source text. */
function declarationInitialiser(
  sourceFile: ts.SourceFile,
  name: string,
): string | null {
  let found: string | null = null;
  eachNode(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer.getText(sourceFile);
    }
  });
  return found;
}

describe("admin membership-cancellation gate (#2354)", () => {
  const sourceFile = parse(PAGE);
  const gate = declarationInitialiser(sourceFile, "canRequestCancellation");

  it("derives the gate from the shared eligibility helper", () => {
    expect(gate).not.toBeNull();
    expect(gate).toContain("canAdminRequestMembershipCancellation");
  });

  it("never gates cancellation on access roles", () => {
    // The regression itself: any access-role predicate here re-hides the
    // action for dependants and non-login adults, whom the API accepts.
    expect(gate).not.toContain("hasAccessRole");
    expect(gate).not.toContain("accessRoles");
    expect(gate).not.toContain("canLogin");
  });

  it("still requires no open request before offering the action", () => {
    // Not part of the API's own validation — the API answers an existing
    // open request with a 409, so the page must not offer a doomed action.
    expect(gate).toContain("openCancellationRequest");
  });
});
