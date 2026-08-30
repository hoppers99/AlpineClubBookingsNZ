import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { getAdminRouteRequirement } from "@/lib/admin-permissions";
import { buildSetupReadiness, normalizeSetupProgress } from "@/lib/setup-readiness";
import { SETUP_STEP_IDS, type SetupStepId } from "@/lib/setup-step-registry";
import { SETUP_STEP_PERMISSION_AREA } from "@/lib/setup-wizard-step-tables";

/**
 * `SETUP_STEP_PERMISSION_AREA`'s own docblock (`setup-wizard-step-tables.ts`)
 * states THE RULE once: a step's area is the area that governs the admin page its
 * readiness check's `href` links to — not a hand-set choice, mechanically
 * derived by feeding that `href` through `getAdminRouteRequirement` (the same
 * resolver `ROUTE_AREA_PREFIXES` backs for every ordinary admin route). This
 * file is the guard that rule never had (C22, #260 fix round): nothing else
 * checks a table entry against the href its own docblock claims to derive it
 * from, so a hand-set entry can drift from its check's `href` — silently,
 * because both `admin-route-map-drift.test.ts` (which walks real Next.js
 * routes, not this table) and `setup-wizard-panes.test.tsx`'s pane test
 * (which only asserts the frame's label agrees with the pane's own banner,
 * never that either is TRUE) explicitly disclaim covering it.
 *
 * That is exactly what happened to `membership-cancellation`: its area was
 * hand-corrected to `membership` in the same fix round that left its check's
 * `href` pointing at `/admin/setup/cancellation` — a `support`-prefixed
 * link-out hub — so the table's own stated rule ("the area is the area that
 * governs the page the check links to") was false of its own entry until the
 * href was corrected too (see `setup-readiness.ts`'s
 * `buildMembershipCancellationCheck`). This test would have failed on that
 * state, by name, before it ever reached review.
 *
 * ## Five edges are judged, not mechanical, and are named here as an
 * allowlist rather than silently skipped
 *
 * `SETUP_STEP_PERMISSION_AREA`'s own docblock names and reasons about all
 * five; the one-line reasons below are a pointer back to it, not a
 * replacement for it.
 *
 * The fifth, `feature-flags`, was found by writing this test and named in that
 * docblock by #270. It had been a judged edge all along — its check carries
 * neither an `href` nor `links` (confirmed against `buildFeatureFlagCheck` in
 * `setup-readiness.ts`), the same shape as `runtime-env` — but the enumeration
 * said "four" for long enough that this allowlist was the only place the edge
 * was written down. Which is the drift the last test in this file now pins:
 * the docblock's enumeration and this allowlist must name the same set, so
 * neither can quietly gain an edge the other does not know about.
 */
const JUDGED_EDGES: Partial<Record<SetupStepId, string>> = {
  "runtime-env":
    "the check carries no href at all (the work is editing .env and restarting) — nothing to resolve mechanically.",
  "finance-dashboard":
    "the href is /finance, the member-facing finance surface — ROUTE_AREA_PREFIXES has nothing to say about a non-admin route.",
  "club-time-zone":
    "the href resolves to support, which is the admission answer, but the page and both verbs of /api/admin/club-time-zone are Full-Admin-enforced IN ROUTE regardless of area.",
  "environment-role":
    "the href resolves to support, which is the admission (and support:view read) answer, but the safer-override WRITE is Full-Admin-enforced IN ROUTE regardless of area.",
  "feature-flags":
    "the check carries no href or links at all — the same shape as runtime-env; named in the table's own docblock since #270.",
};

function checkHrefs(): Partial<Record<SetupStepId, string | undefined>> {
  const readiness = buildSetupReadiness({
    env: {},
    database: undefined,
    progress: normalizeSetupProgress({
      completedStepIds: [],
      skippedStepIds: [],
      completedAt: null,
      completedByMemberId: null,
    }),
  });
  const hrefs: Partial<Record<SetupStepId, string | undefined>> = {};
  for (const category of readiness.categories) {
    for (const check of category.checks) {
      hrefs[check.id] = check.href;
    }
  }
  return hrefs;
}

describe("SETUP_STEP_PERMISSION_AREA matches the check href mechanically (C22, #260 fix round)", () => {
  const hrefs = checkHrefs();

  it("names exactly the five judged edges (four documented, one this test found) — no more, no fewer", () => {
    // A step moved into or out of the judged set is a decision worth a
    // reviewer's eyes, so this fails loudly rather than silently widening or
    // narrowing the allowlist.
    expect(Object.keys(JUDGED_EDGES).sort()).toEqual(
      [
        "club-time-zone",
        "environment-role",
        "feature-flags",
        "finance-dashboard",
        "runtime-env",
      ].sort(),
    );
  });

  for (const id of SETUP_STEP_IDS) {
    if (id in JUDGED_EDGES) continue;

    it(`derives "${id}"'s permission area mechanically from its check's href`, () => {
      const href = hrefs[id];
      expect(
        href,
        `"${id}" has no href — either it belongs in JUDGED_EDGES (with a reason) or its check is missing one`,
      ).toBeTruthy();

      const requirement = getAdminRouteRequirement(href as string, "GET");
      expect(
        requirement,
        `"${id}"'s href "${href}" does not resolve through ROUTE_AREA_PREFIXES — either register it there, or move "${id}" into JUDGED_EDGES with a reason`,
      ).not.toBeNull();

      expect(
        SETUP_STEP_PERMISSION_AREA[id],
        `SETUP_STEP_PERMISSION_AREA["${id}"] is "${SETUP_STEP_PERMISSION_AREA[id]}", but its check's href "${href}" mechanically resolves to "${requirement?.area}" — see setup-wizard-step-tables.ts's own docblock rule`,
      ).toBe(requirement?.area);
    });
  }
});

/**
 * The enumeration and the allowlist must name the SAME set (#270).
 *
 * `SETUP_STEP_PERMISSION_AREA`'s docblock enumerates the judged edges in prose,
 * and `JUDGED_EDGES` above enumerates them in code. Nothing tied the two
 * together, and they drifted: `feature-flags` was a judged edge that only the
 * code half knew about, while the prose half said "four" and listed four. A
 * reader trusting the docblock — which is the half written to be read — was
 * told something untrue.
 *
 * So this reads the docblock's own bullets back off disk. It is bounded to the
 * judged-edge section deliberately: `SETUP_STEP_DEFAULTED_EVIDENCE`'s docblock
 * further down the same file uses the identical bullet shape for a different
 * set, and an unbounded scan would silently mix the two.
 */
describe("the judged-edge enumeration and the allowlist agree (#270)", () => {
  const SECTION_START = 'edges where "the page the work is done on" does not settle';
  const SECTION_END = "A `Record` over the id union rather than a lookup with a fallback";

  function documentedJudgedEdges(): string[] {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/setup-wizard-step-tables.ts"),
      "utf8",
    );
    const from = source.indexOf(SECTION_START);
    const to = source.indexOf(SECTION_END);
    expect(
      from,
      `could not find the judged-edge section's opening line in setup-wizard-step-tables.ts — if that prose was reworded, update SECTION_START here rather than deleting this guard`,
    ).toBeGreaterThan(-1);
    expect(
      to,
      `could not find the judged-edge section's closing paragraph in setup-wizard-step-tables.ts — if that prose was reworded, update SECTION_END here rather than deleting this guard`,
    ).toBeGreaterThan(from);

    return [
      ...source.slice(from, to).matchAll(/^\s*\*\s+-\s+\*\*`([a-z-]+)`/gm),
    ].map((m) => m[1]);
  }

  it("names every allowlisted edge in the docblock, and no others", () => {
    const documented = documentedJudgedEdges();
    expect(
      [...documented].sort(),
      "the docblock's enumerated judged edges and JUDGED_EDGES in this file have drifted — whichever is wrong, they must name the same set",
    ).toEqual(Object.keys(JUDGED_EDGES).sort());
  });

  it("states the right COUNT in its own prose, not just the right list", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/setup-wizard-step-tables.ts"),
      "utf8",
    );
    const count = documentedJudgedEdges().length;
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven"];
    expect(
      source,
      `the docblock enumerates ${count} judged edges, so its prose must say "${words[count]} edges" — a stale count is what #270 was filed for`,
    ).toContain(`it has ${words[count]} edges`);
  });
});
