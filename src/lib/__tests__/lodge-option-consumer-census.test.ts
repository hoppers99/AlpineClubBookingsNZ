import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const EXPECTED_DIRECT_CONSUMERS = [
  "src/app/(admin)/admin/display/builder/page.tsx",
  "src/app/(admin)/admin/display/devices/page.tsx",
  "src/app/(admin)/admin/display/reference/page.tsx",
  "src/app/(admin)/admin/display/setup/use-display-wizard-context.ts",
  "src/app/(admin)/admin/display/templates/page.tsx",
  "src/app/(admin)/admin/lodges/[id]/page.tsx",
  "src/app/(admin)/admin/lodges/[id]/setup/page.tsx",
  "src/app/(admin)/admin/lodges/page.tsx",
  "src/app/(authenticated)/book/whole-lodge/_components/whole-lodge-request-form.tsx",
  "src/components/admin/lodge-details-panel.tsx",
  "src/components/admin/notice-audience-picker.tsx",
] as const;

/*
  Every `useLodgeOptions` consumer, AND the scope it asks for (#221).

  The scope is the half that matters now. `"configuration"` is the only scope
  whose list contains lodges that are not open for booking, and it exists for
  exactly one job: the five full editors that build a lodge's own inventory
  while it is still being set up. `"member"` and `"admin"` keep the filtered
  list every member, booking, roster, board, display and report surface has
  always had.

  Pinning the MAP rather than the file list is what makes that split
  mechanical. A page can only gain inactive lodges by changing its scope, which
  changes this table, which is where a reviewer is asked whether that page is
  really configuring a lodge or merely operating one — the same question the
  `resolveOptionalActiveLodgeId` / `resolveOptionalConfigurableLodgeId` pair
  asks on the server, and the two halves have to agree.
*/
const EXPECTED_HOOK_CONSUMERS: Record<string, string[]> = {
  // The five configuration editors. Each is linked from the per-lodge setup
  // flow or the lodge hub with `?lodgeId=<the-new-lodge>`, and each writes
  // through a route on the CONFIGURABLE resolver.
  "src/app/(admin)/admin/chores/page.tsx": ["configuration"],
  "src/app/(admin)/admin/fees/_components/hut-fees-section.tsx": [
    "configuration",
  ],
  "src/app/(admin)/admin/lockers/page.tsx": ["configuration"],
  "src/app/(admin)/admin/seasons/page.tsx": ["configuration"],
  "src/components/admin/rooms-beds-manager.tsx": ["configuration"],

  // Everything else OPERATES a lodge rather than configuring one — you do not
  // roster, allocate beds at, price a promotion for, or report on a building
  // nobody can book.
  "src/app/(admin)/admin/bed-allocation/page.tsx": ["admin"],
  "src/app/(admin)/admin/book/page.tsx": ["admin"],
  "src/app/(admin)/admin/hut-leaders/page.tsx": ["admin"],
  "src/app/(admin)/admin/lodge/page.tsx": ["admin"],
  "src/app/(admin)/admin/members/[id]/_components/member-lodge-access-card.tsx":
    ["admin"],
  "src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx": ["admin"],
  "src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx": ["admin"],
  "src/app/(admin)/admin/reports/page.tsx": ["admin"],
  "src/app/(admin)/admin/roster/page.tsx": ["admin"],
  "src/app/(admin)/admin/work-parties/page.tsx": ["admin"],
  "src/components/admin/booking-policies/policy-scope-select.tsx": ["admin"],
  // The per-lodge capacity override card. It offers no `?lodgeId=` entry point
  // — its selection is only ever made on screen — so it cannot be pointed at a
  // closed lodge and stays on the operating list.
  "src/components/admin/lodge-capacity-card.tsx": ["admin"],
  "src/app/(authenticated)/book/_hooks/use-booking-wizard.ts": ["member"],
};

/** `useLodgeOptions("admin")`, `useLodgeOptions()`, `useLodgeOptions(\n"x")`. */
const HOOK_CALL = /useLodgeOptions\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)/g;

/*
  #2887: this used to match three hardcoded literal spellings
  (`fetch("/api/admin/lodges"`, `fetch("/api/lodges"`, and one exact endpoint
  constant), so the next consumer writing a template literal or adding a query
  string was invisible to a census whose entire job is to be exhaustive.

  Both patterns stay anchored to a CALL or a named endpoint, deliberately: a
  bare search for the path also hits the permission matrix, the proxy route
  table and prose, none of which fetch anything.
*/
const LODGE_LIST_FETCH = /fetch\(\s*[`'"][^`'"]*\/api\/(?:admin\/)?lodges/;
const LODGE_LIST_ENDPOINT_CONST =
  /(?:const|let|var)\s+\w*(?:ENDPOINT|URL|PATH)\w*\s*=\s*[`'"][^`'"]*\/api\/(?:admin\/)?lodges/i;

function productionSources(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...productionSources(path));
    } else if (
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function repoPath(path: string): string {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

describe("production lodge-option consumers stay in the fail-closed census (#2887)", () => {
  const sources = productionSources(join(process.cwd(), "src"));

  it("counts every direct lodge-list consumer", () => {
    const actual = sources
      .filter((path) => {
        if (repoPath(path) === "src/components/lodge-select.tsx") return false;
        const body = readFileSync(path, "utf8");
        return LODGE_LIST_FETCH.test(body) || LODGE_LIST_ENDPOINT_CONST.test(body);
      })
      .map(repoPath)
      .sort();

    expect(actual).toEqual([...EXPECTED_DIRECT_CONSUMERS].sort());
  });

  it("counts every useLodgeOptions consumer, and pins the SCOPE each one asks for", () => {
    const actual: Record<string, string[]> = {};
    for (const path of sources) {
      const body = readFileSync(path, "utf8");
      if (!body.includes("useLodgeOptions(")) continue;
      if (body.includes("function useLodgeOptions(")) continue;
      // `"member"` is the hook's default, so an omitted argument is that scope
      // and is recorded as such rather than as a hole in the census.
      const scopes = [...body.matchAll(HOOK_CALL)].map(
        (match) => match[1] ?? match[2] ?? "member",
      );
      actual[repoPath(path)] = [...new Set(scopes)].sort();
    }

    expect(actual).toEqual(EXPECTED_HOOK_CONSUMERS);
  });

  it("keeps `configuration` — the only scope that sees a closed lodge — to the five editors", () => {
    /*
      Stated as its own assertion because it is the safety property, not a
      bookkeeping one: a surface on this list can be pointed at a lodge that is
      not open for booking, and a surface that OPERATES a lodge must never be.
      Reading it out of the table above rather than re-deriving it means the two
      cannot disagree.
    */
    const configuring = Object.entries(EXPECTED_HOOK_CONSUMERS)
      .filter(([, scopes]) => scopes.includes("configuration"))
      .map(([file]) => file)
      .sort();

    expect(configuring).toEqual([
      "src/app/(admin)/admin/chores/page.tsx",
      "src/app/(admin)/admin/fees/_components/hut-fees-section.tsx",
      "src/app/(admin)/admin/lockers/page.tsx",
      "src/app/(admin)/admin/seasons/page.tsx",
      "src/components/admin/rooms-beds-manager.tsx",
    ]);
  });
});
