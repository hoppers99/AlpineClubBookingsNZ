import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// #1923 source contract: the held-request conversion fences claim on an integer
// `version` column instead of the millisecond-precision `updatedAt`. Two writes
// in the same millisecond produce an identical updatedAt and silently defeat a
// timestamp CAS; an integer counter cannot collide. For the fence to be sound,
// EVERY mutating write of a BookingRequest row must bump the counter, so any
// writer that lands after a converter's locked re-read moves the version and
// invalidates the stale claim.
//
// This scan enumerates every `bookingRequest.update(` / `bookingRequest.update
// Many(` call site in src/ and fails CI if any of them omits
// `version: { increment: 1 }` in its data — a future writer cannot forget the
// bump. It also pins the two conversion claims to fence on `version:
// request.version`, so a regression to the old updatedAt fence is a test
// failure rather than a silent precision dependence.

const SRC_DIR = path.join(process.cwd(), "src");
const INCREMENT = "version: { increment: 1 }";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/** Strip `//` line comments so balanced/unbalanced parens in prose cannot
 * confuse the paren matcher below. Block comments are not used inside these
 * calls, so a line-comment strip is sufficient. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Given `source` and the index of the `(` that opens a call, return the call
 * text up to and including its matching `)`. The Prisma calls contain no string
 * literals with parentheses, so naive depth counting is exact here. */
function extractCall(source: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIdx, i + 1);
    }
  }
  return source.slice(openParenIdx);
}

interface CallSite {
  rel: string;
  kind: "update" | "updateMany";
  body: string;
}

function collectCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  const sources = walk(SRC_DIR)
    .map((file) => ({
      rel: path.relative(process.cwd(), file).split(path.sep).join("/"),
      text: stripLineComments(fs.readFileSync(file, "utf8")),
    }))
    .filter(({ rel }) => !isTestFile(rel));

  const pattern = /\.bookingRequest\.(update|updateMany)\(/g;
  for (const { rel, text } of sources) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const openParen = match.index + match[0].length - 1;
      sites.push({
        rel,
        kind: match[1] as "update" | "updateMany",
        body: extractCall(text, openParen),
      });
    }
  }
  return sites;
}

describe("BookingRequest version-fence source contract (#1923)", () => {
  const sites = collectCallSites();

  it("finds every BookingRequest write call site", () => {
    // Guard against a silent no-op if the scan regex ever stops matching.
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  it("bumps version on every mutating BookingRequest write", () => {
    const offenders = sites
      .filter((site) => !site.body.includes(INCREMENT))
      .map((site) => `${site.rel} (bookingRequest.${site.kind})`);

    expect(
      offenders,
      "Every bookingRequest.update/updateMany must include " +
        "`version: { increment: 1 }` in its data (#1923). A write that skips it " +
        "would let a converter's optimistic version fence stay valid across a " +
        "concurrent mutation, resurrecting the millisecond-precision race the " +
        "integer counter replaced. Add the increment to the flagged call sites."
    ).toEqual([]);
  });

  it("keeps both held-conversion claims fencing on version: request.version", () => {
    const fenceFiles = [
      "src/lib/booking-request.ts",
      "src/lib/school-booking-request.ts",
    ];
    for (const rel of fenceFiles) {
      const raw = fs.readFileSync(
        path.join(process.cwd(), rel.split("/").join(path.sep)),
        "utf8"
      );
      const source = stripLineComments(raw);
      // The conversion claim fences on the observed integer version, not the
      // millisecond-collidable updatedAt.
      expect(source, `${rel} must fence the conversion claim on version`).toContain(
        "version: request.version"
      );
      expect(
        source,
        `${rel} must no longer fence the conversion claim on updatedAt`
      ).not.toContain("updatedAt: request.updatedAt");
    }
  });
});
