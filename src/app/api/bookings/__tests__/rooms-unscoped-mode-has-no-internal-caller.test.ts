import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * `INV-INT-016` — the no-`lodgeId` mode of `GET /api/bookings/rooms` is kept for
 * consumers OUTSIDE this repository, and no client inside it may use it (#2678
 * surface 4).
 *
 * Two halves, and they are not the same claim:
 *
 *  - **The mode stays.** It is the pre-multi-lodge signature, and forked booking
 *    wizards and external integrations still call it that way, so requiring
 *    `lodgeId` would break them for no internal gain. From inside this tree the
 *    branch looks like dead code since #2677, which is exactly why it needs a
 *    rule with the reason attached rather than a test alone —
 *    `docs/invariants/integrations.md`.
 *  - **Nothing in `src/` calls it unscoped.** Internal reuse of the mode IS the
 *    #2664 defect: a picker on a booking whose lodge is already fixed loading
 *    club-wide room options and offering another lodge's rooms, which the writer
 *    then refuses. #2673 moved the requested-room picker onto a booking-scoped
 *    route and #2677 moved the wizard onto `?lodgeId=`; this stops the shape
 *    coming back.
 *
 * The sweep reads COMMENT-STRIPPED source, because several files discuss the
 * unscoped mode at length in prose — including the route that replaced it — and
 * a plain text search reads those explanations as call sites.
 */

const ROUTE = "/api/bookings/rooms";

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      files.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  };
  walk(path.resolve(process.cwd(), "src"));
  return files;
}

describe("INV-INT-016: /api/bookings/rooms unscoped mode (#2678)", () => {
  it("has no caller in src/ that omits lodgeId", () => {
    const unscoped: string[] = [];
    for (const file of sourceFiles()) {
      // The endpoint's own handler names its path in a URL only incidentally;
      // it is the thing being called, not a caller.
      if (file === "src/app/api/bookings/rooms/route.ts") continue;
      const code = stripComments(readFileSync(file, "utf8"));
      // Every literal reference to the route, with whatever query string is
      // attached, up to the closing quote or template backtick.
      for (const match of code.matchAll(
        new RegExp(`${ROUTE}([^"'\`\\n]*)`, "g"),
      )) {
        const query = match[1];
        if (query.includes("lodgeId")) continue;
        unscoped.push(`${file}: ${match[0]}`);
      }
    }
    expect(
      unscoped.sort(),
      `A client in src/ calls ${ROUTE} without a lodgeId. That is the #2664 ` +
        "defect: room options for a booking (or a wizard step) whose lodge is " +
        "already fixed must be scoped to that lodge server-side, or the picker " +
        "offers rooms the writer will refuse. The unscoped mode exists for " +
        "FORKED and EXTERNAL consumers only — see INV-INT-016 in " +
        "docs/invariants/integrations.md.",
    ).toEqual([]);
  });

  it("still SERVES the unscoped mode, so a fork's pre-multi-lodge call keeps working", () => {
    // The complement, and the half a "no internal caller" test cannot state on
    // its own: the rule is "keep it and stop calling it", not "remove it". A
    // future tidy-up that deletes the branch because nothing internal uses it
    // fails here rather than shipping a breaking change to a documented
    // endpoint.
    const route = stripComments(
      readFileSync("src/app/api/bookings/rooms/route.ts", "utf8"),
    );
    // The unscoped branch: no `lodgeId` on the query string falls through to an
    // eligibility-filtered cross-lodge listing rather than a 400.
    expect(route).toContain("getEligibleLodgeIdsForMember");
    expect(route).not.toMatch(/lodgeId\s+is\s+required/i);
    // A missing lodgeId must not be turned into a refusal.
    expect(route).not.toMatch(
      /if\s*\(\s*!lodgeId\s*\)[\s\S]{0,120}status:\s*400/,
    );
  });
});
