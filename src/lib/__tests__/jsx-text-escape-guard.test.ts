import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  A backslash escape sequence in JSX TEXT is not an escape. It is text.

  #2690 found two of them on live screens, both of which had been there for
  months and neither of which any test noticed:

    - the partner quick-add button on the booking edit panel, which read
      "Jane Smith — partner of Bob" to every officer who opened it (#1746);
    - the over-capacity warning on the admin new-booking page, which read
      "You can still create it — you will confirm..." (#1668).

  WHY THIS CLASS SURVIVES REVIEW. JSX has two kinds of text that look identical
  in a diff and behave differently:

      {alreadyAdded ? "✓ " : "+ "}          <-- string literal: RESOLVES
      {a} {b} — partner of {c}              <-- JSX text: RENDERED LITERALLY

  Those two lines sat two lines apart in the same component. A reader who has
  just read the first cannot help reading the second the same way, and the
  rendered output is only wrong by a few characters, so it survives a screenshot
  too. Nothing but a parser reliably tells them apart, which is what this does.

  SCOPE. `\u` and `\x` are the sequences that produce the visible garbage. `\n`,
  `\r`, `\t` and `\0` are included because a developer writing one in JSX text
  means a line break or a tab and gets a stray backslash instead — JSX collapses
  real whitespace, so the intent is always something else. HTML entities
  (`&mdash;`, `&nbsp;`) are deliberately NOT matched: JSX does interpret those,
  so they are a legitimate second spelling.
*/

const ROOTS = ["src", "e2e"];

/** The escapes a developer plausibly expects JSX to resolve. It does not. */
const ESCAPE_IN_TEXT = /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[ntr0])/g;

function tsxFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      tsxFiles(full, out);
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

interface Finding {
  where: string;
  match: string;
  line: string;
}

function scan(file: string, source: string): Finding[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const lines = source.split("\n");
  const found: Finding[] = [];
  const visit = (node: ts.Node): void => {
    // ONLY JsxText. A string literal inside a JSX expression is a different node
    // kind and is left alone, because there the escape genuinely resolves.
    if (ts.isJsxText(node)) {
      const text = node.getFullText(sourceFile);
      ESCAPE_IN_TEXT.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ESCAPE_IN_TEXT.exec(text))) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getFullStart() + match.index,
        );
        found.push({
          where: `${file.split(sep).join("/")}:${line + 1}`,
          match: match[0],
          line: (lines[line] ?? "").trim().slice(0, 120),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return found;
}

describe("no backslash escape sequence is left sitting in JSX text", () => {
  const files = ROOTS.flatMap((root) => tsxFiles(root));

  it("scans a tree that actually contains JSX, so it cannot pass vacuously", () => {
    expect(files.length, "no .tsx files found; the scan is checking nothing").toBeGreaterThan(
      200,
    );
    const jsxTextNodes = files.reduce((total, file) => {
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      let count = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isJsxText(node)) count += 1;
        node.forEachChild(visit);
      };
      visit(sourceFile);
      return total + count;
    }, 0);
    expect(jsxTextNodes).toBeGreaterThan(10_000);
  });

  it("detects a planted one, so the matcher is known to work", () => {
    // The guard's own self-test. Without it, a regex that silently stopped
    // matching would report a clean tree for ever.
    const planted = scan(
      "planted.tsx",
      "export const A = () => <p>Jane \\u2014 partner of Bob</p>;",
    );
    expect(planted).toHaveLength(1);
    expect(planted[0].match).toBe("\\u2014");

    // ...and does NOT fire on the legitimate string-literal spelling beside it.
    const legitimate = scan(
      "legit.tsx",
      'export const B = ({ x }: { x: boolean }) => <p>{x ? "\\u2713 " : "+ "}ok</p>;',
    );
    expect(legitimate).toEqual([]);
  });

  it("finds none anywhere under src/ or e2e/", () => {
    const findings = files.flatMap((file) => scan(file, readFileSync(file, "utf8")));

    expect(
      findings.map((f) => `${f.where}  ${f.match}  |  ${f.line}`),
      "JSX does not interpret backslash escapes in TEXT — these render " +
        "literally on screen. Write the character itself (the repository's " +
        "convention: every other em dash in JSX text is a real one), or move " +
        "the string into an expression like {'\\u2014'} where the escape " +
        "resolves. An HTML entity such as &mdash; is fine too.",
    ).toEqual([]);
  });
});
