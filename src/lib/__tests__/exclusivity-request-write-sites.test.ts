import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  #2263 / ADR-001 (dated entry, 2026-07-30) — the sanctioned front-doors that may
  ASK for a whole-lodge exclusive hold.

  The behavioural pin in booking-request.test.ts proves the PUBLIC create path
  writes no `exclusivityRequested`. It cannot prove anything about a door that
  does not exist yet: a fourth front-door added next year would simply not be
  covered by a test nobody thought to write. This scan closes that. It finds
  every WRITE of `exclusivityRequested` in the source tree and asserts the set of
  files containing one is exactly the sanctioned set.

  Why this flag is worth a scan of its own. It is the request-side half of the
  one capacity action that sterilises every bed in the lodge (ADR-001). A path
  that could set it without an authenticated, capped, audited requester behind it
  would let somebody ask the club to empty the building on a date of their
  choosing. The ADMIN action that GRANTS the hold (`Booking.wholeLodgeHold`) is a
  separate flag and deliberately out of scope: an admin may set that on any
  booking, and only the REQUEST front-doors are enumerated here.

  It runs over the TypeScript AST rather than over file text, for the reason
  `view-only-banner-contract.test.ts` had to learn twice: raw text cannot tell a
  write from a Prisma `select`, from a type declaration, or from prose about any
  of them — and the files in this area are heavily commented with the very
  expressions being matched.

  Adding a legitimate new door means adding it to SANCTIONED_WRITE_SITES with a
  reason, which is exactly the reviewable diff this test exists to force.
*/

const SRC = join(process.cwd(), "src");

/**
 * The only files allowed to WRITE `exclusivityRequested`, each with why. A file
 * listed here must still write it for an authenticated or email-verified
 * requester — the entry records the decision, it does not waive it.
 */
const SANCTIONED_WRITE_SITES: Record<string, string> = {
  // Door 1 — the school/group front-door (#121). Public, but email-verified,
  // rate limited, and it lands in the officer queue holding nothing.
  "lib/school-booking-request.ts":
    "SCHOOL front-door: persists the requester's exclusivity ask on submission, and re-states it in the approval audit metadata (#121, ADR-001).",
  "app/api/booking-requests/school/route.ts":
    "SCHOOL front-door route: validates the submitted flag and passes it to createSchoolBookingRequest.",
  // Door 2 — the authenticated member door (#2263). Session-bound, capped at two
  // open requests, rate limited per-IP and per-member, always attributed.
  "lib/booking-request.ts":
    "MEMBER whole-lodge front-door: createMemberWholeLodgeRequest stamps exclusivityRequested together with requestedByMemberId, from the session only; the admin serialiser re-emits the stored value for the queue badge (#2263).",
};

/** Prisma clause keys whose object literals are READS, never writes. */
const READ_CLAUSE_KEYS = new Set([
  "select",
  "where",
  "include",
  "orderBy",
  "omit",
  "distinct",
  "_count",
]);

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests describe the rule; they do not implement a front-door.
      if (entry.name === "__tests__") return [];
      return listSourceFiles(entryPath);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

/**
 * True when this `exclusivityRequested` property assignment is a WRITE.
 *
 * A `PropertySignature` (`exclusivityRequested: boolean` in an interface) is not
 * a PropertyAssignment at all, so type declarations never reach here. A property
 * nested anywhere inside a Prisma `select` / `where` / `include` object is a
 * read of the column, not a write to it, and is excluded — otherwise every
 * consumer that merely LOOKS at the flag would masquerade as a front-door and
 * the list would stop meaning anything.
 */
function isWriteAssignment(node: ts.PropertyAssignment): boolean {
  let cursor: ts.Node | undefined = node.parent;
  while (cursor) {
    if (
      ts.isPropertyAssignment(cursor) &&
      (ts.isIdentifier(cursor.name) || ts.isStringLiteral(cursor.name)) &&
      READ_CLAUSE_KEYS.has(cursor.name.text)
    ) {
      return false;
    }
    cursor = cursor.parent;
  }
  return true;
}

function hasWriteSite(file: string): boolean {
  let found = false;
  eachNode(parse(file), (node) => {
    if (found) return;
    if (!ts.isPropertyAssignment(node)) return;
    if (!ts.isIdentifier(node.name)) return;
    if (node.name.text !== "exclusivityRequested") return;
    if (isWriteAssignment(node)) found = true;
  });
  return found;
}

describe("whole-lodge exclusivity request write sites (#2263, ADR-001)", () => {
  it("has exactly the sanctioned front-doors and no others", () => {
    const found = listSourceFiles(SRC)
      .filter(hasWriteSite)
      .map((file) => relative(SRC, file).split(sep).join("/"))
      .sort();

    expect(
      found,
      "A file that WRITES exclusivityRequested is a front-door for asking the " +
        "club to sterilise every bed in the lodge. Only the authenticated " +
        "member door (#2263) and the email-verified school door (#121) are " +
        "sanctioned. Add a new one to SANCTIONED_WRITE_SITES with its reason, " +
        "or take the write out.",
    ).toEqual(Object.keys(SANCTIONED_WRITE_SITES).sort());
  });

  it("keeps the member door attributing every request it opens", () => {
    /*
      The member door's guarantee is not merely "it may set the flag" but "it
      always says who asked". An unattributed member-origin row would be
      invisible to My requests, uncounted by the open-request cap, and
      impossible for its own author to withdraw — a request that can only ever
      be resolved by an admin noticing it.
    */
    const source = readFileSync(join(SRC, "lib", "booking-request.ts"), "utf8");
    const ast = parse(join(SRC, "lib", "booking-request.ts"));

    let createBody: string | null = null;
    eachNode(ast, (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "createMemberWholeLodgeRequest"
      ) {
        createBody = source.slice(node.getStart(ast), node.getEnd());
      }
    });

    expect(createBody, "createMemberWholeLodgeRequest was not found").not.toBeNull();
    expect(createBody!).toContain("exclusivityRequested: true");
    expect(createBody!).toContain("requestedByMemberId: member.id");
  });
});
