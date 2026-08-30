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
  // C19 (#250) lifted the lodge list out of `lodges/page.tsx` into a zero-prop
  // section the setup wizard mounts inline. The direct fetch changed FILE, not
  // what it reads or who may call it — `GET /api/admin/lodges` still narrows
  // its payload below `lodge:view` (#2925) and this is still the list screen's
  // own read. The page it left is now a shell with no fetch, so it correctly
  // drops off this census.
  "src/app/(admin)/admin/lodges/lodges-section.tsx",
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
  // C23 (#261) lifted this out of `seasons/page.tsx` into a zero-prop section
  // the setup wizard mounts inline, the same move C19 made for the lodge list
  // above — the hook call moved FILE, not scope.
  "src/app/(admin)/admin/seasons/seasons-section.tsx": ["configuration"],
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

/*
  Finding 2 (#221 review, latent): `LodgeOption.active` is a public field on
  the wire, and the two censuses above only pin HOW a file gets its lodge data
  (`useLodgeOptions` scope, or a direct fetch). Neither looks at what a file
  then does with it, so a hypothetical consumer that fetched
  `/api/admin/lodges` directly and handed the raw, inactive-bearing rows
  straight to `<LodgeSelect>` — never calling `useLodgeOptions` at all — would
  trip neither census while still reaching a member/booking/roster surface
  with lodges the scope split exists to keep off it.

  This pins the seam shut at the component boundary: every production file
  that renders `<LodgeSelect` must either call `useLodgeOptions` itself (and
  so already appear in `EXPECTED_HOOK_CONSUMERS` above) or be a presentational
  component whose `lodges` prop is threaded from a file that does — named
  below, with the hook consumer that feeds it, so the thread can be checked by
  hand. A file that renders `<LodgeSelect` and is in neither list fails
  closed: it is unaccounted, whether it turns out to be a new hook consumer
  missing from the table or a direct-fetch consumer of exactly the shape this
  guard exists to catch.
*/
const PRESENTATIONAL_LODGE_SELECT_CONSUMERS: Record<string, string> = {
  // Purely presentational: receives `lodges`, `lodgeScope` etc. as props from
  // `useBookingWizard`, which owns the `useLodgeOptions("member")` call (see
  // EXPECTED_HOOK_CONSUMERS above).
  "src/app/(authenticated)/book/_components/dates-step.tsx":
    "src/app/(authenticated)/book/_hooks/use-booking-wizard.ts",
};

const LODGE_SELECT_JSX = /<LodgeSelect\b/;

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

  it("renders <LodgeSelect> only from a hook consumer or a named presentational passthrough (finding 2, #221 review)", () => {
    const renderers = sources
      .filter((path) => LODGE_SELECT_JSX.test(readFileSync(path, "utf8")))
      .map(repoPath)
      .sort();

    // Forward, and the actual safety property: every renderer must be a known
    // hook consumer or a named presentational passthrough. A hook consumer is
    // NOT required to render `<LodgeSelect>` itself — several legitimately
    // use the list for something else (a filter, a check, a differently-built
    // control) — so the check only runs this direction, on `renderers`, not
    // as a full-table equality.
    const allowed = new Set([
      ...Object.keys(EXPECTED_HOOK_CONSUMERS),
      ...Object.keys(PRESENTATIONAL_LODGE_SELECT_CONSUMERS),
    ]);
    const unaccounted = renderers.filter((path) => !allowed.has(path));
    expect(unaccounted).toEqual([]);

    // Reverse, scoped to the presentational table only (not every hook
    // consumer, per the above): each entry there is named specifically
    // because it renders `<LodgeSelect>` via a passthrough, so if that stops
    // being true the doc claim has gone stale and this catches it.
    for (const path of Object.keys(PRESENTATIONAL_LODGE_SELECT_CONSUMERS)) {
      expect(renderers).toContain(path);
    }

    // The passthrough claim's other half: the hook consumer named as each
    // presentational file's source must actually be one, so that pointer
    // cannot go stale into naming a file that no longer calls the hook.
    for (const hookFile of Object.values(PRESENTATIONAL_LODGE_SELECT_CONSUMERS)) {
      expect(Object.keys(EXPECTED_HOOK_CONSUMERS)).toContain(hookFile);
    }
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
      "src/app/(admin)/admin/seasons/seasons-section.tsx",
      "src/components/admin/rooms-beds-manager.tsx",
    ]);
  });
});
