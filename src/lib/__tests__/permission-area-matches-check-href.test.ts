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
 * ## Four edges are judged, not mechanical, and are named here as an
 * allowlist rather than silently skipped
 *
 * `SETUP_STEP_PERMISSION_AREA`'s own docblock names and reasons about all
 * four; the one-line reasons below are a pointer back to it, not a
 * replacement for it.
 *
 * ## A fifth this test found, that the docblock does not yet name
 *
 * `feature-flags` carries neither an `href` nor `links` at all (confirmed
 * against `buildFeatureFlagCheck` in `setup-readiness.ts`, and
 * `setup-wizard-panes.tsx`'s own comment on why that step has no destination
 * to link a pane against either) — so there is nothing for this test to
 * resolve mechanically, the same shape as `runtime-env`. Writing this test is
 * what surfaced it: `SETUP_STEP_PERMISSION_AREA`'s docblock (now in
 * `setup-wizard-step-tables.ts`, #268) still says "four edges" and does not
 * list this one, which is a pre-existing gap this fix round did
 * not introduce and is out of scope to correct here (the file is at its
 * 700-line budget) — flagged to the orchestrator to file separately rather
 * than silently left for the next reader to trip over again.
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
    "the check carries no href or links at all — the same shape as runtime-env — and setup-wizard-view.ts's docblock does not yet name it; see the note above.",
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
        `SETUP_STEP_PERMISSION_AREA["${id}"] is "${SETUP_STEP_PERMISSION_AREA[id]}", but its check's href "${href}" mechanically resolves to "${requirement?.area}" — see setup-wizard-view.ts's own docblock rule`,
      ).toBe(requirement?.area);
    });
  }
});
