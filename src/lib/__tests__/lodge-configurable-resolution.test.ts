import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  resolveOptionalActiveLodgeId,
  resolveOptionalConfigurableLodgeId,
} from "@/lib/lodges";

/**
 * Configuring a lodge is a different question from operating one (#221, epic
 * #213 C6).
 *
 * `resolveOptionalActiveLodgeId` answers "may this lodge be booked, priced,
 * rostered, staffed" and refuses an inactive one. Six admin routes were using
 * it to answer "may this lodge's own inventory be edited", which was harmless
 * only while no lodge could be inactive and under configuration at once. Since
 * #221 a new lodge starts inactive, so every quick-seed and copy step of the
 * per-lodge setup flow would have 400'd on the very lodge it exists to
 * configure.
 *
 * The rule and the call-site list live in
 * `docs/multi-lodge/lodge-scoping-contract.md` → "Lodge Creation Defaults, And
 * Configuring A Lodge That Is Not Yet Active". The census at the foot of this
 * file is what keeps the code and that list honest in BOTH directions: a
 * booking-facing route quietly adopting the permissive resolver is the
 * dangerous drift, and it is the one a census catches and a behaviour test
 * never would.
 */

type LodgeRow = { id: string; active: boolean } | null;

function db(row: LodgeRow, defaultLodgeId = "default-lodge") {
  const findUnique = vi.fn().mockResolvedValue(row);
  const findFirst = vi.fn().mockResolvedValue({ id: defaultLodgeId });
  return {
    client: { lodge: { findUnique, findFirst } } as never,
    findUnique,
    findFirst,
  };
}

describe("the two lodge resolvers disagree on exactly one thing (#221)", () => {
  it("both accept an ACTIVE lodge by id", async () => {
    const active = { id: "lodge-1", active: true };
    await expect(
      resolveOptionalActiveLodgeId(db(active).client, "lodge-1"),
    ).resolves.toBe("lodge-1");
    await expect(
      resolveOptionalConfigurableLodgeId(db(active).client, "lodge-1"),
    ).resolves.toBe("lodge-1");
  });

  it("only the configuration resolver accepts an INACTIVE lodge", async () => {
    const inactive = { id: "lodge-2", active: false };
    // The operate question: no. A closed lodge takes no bookings.
    await expect(
      resolveOptionalActiveLodgeId(db(inactive).client, "lodge-2"),
    ).resolves.toBeNull();
    // The configure question: yes. A closed lodge is precisely the one being
    // set up, which is what the per-lodge setup flow does before activating it.
    await expect(
      resolveOptionalConfigurableLodgeId(db(inactive).client, "lodge-2"),
    ).resolves.toBe("lodge-2");
  });

  it("both still refuse an id that names no lodge at all", async () => {
    await expect(
      resolveOptionalActiveLodgeId(db(null).client, "nope"),
    ).resolves.toBeNull();
    await expect(
      resolveOptionalConfigurableLodgeId(db(null).client, "nope"),
    ).resolves.toBeNull();
  });

  it("both still fall back to the club default when no id is supplied", async () => {
    await expect(
      resolveOptionalActiveLodgeId(db(null).client, undefined),
    ).resolves.toBe("default-lodge");
    await expect(
      resolveOptionalConfigurableLodgeId(db(null).client, null),
    ).resolves.toBe("default-lodge");
  });

  it("the configuration resolver never reads `active` at all", async () => {
    // Structural rather than behavioural: it selects only `id`, so there is no
    // active flag in scope for a future edit to start consulting by accident.
    const { client, findUnique } = db({ id: "lodge-3", active: false });
    await resolveOptionalConfigurableLodgeId(client, "lodge-3");
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "lodge-3" },
      select: { id: true },
    });
  });
});

/*
  THE FAIL-CLOSED CENSUS.

  Written out rather than derived, for the reason every census in this
  repository is: a list that recomputes itself from the thing it is pinning
  proves nothing. A new entry here is a deliberate statement that the route
  configures a lodge rather than operates one — and if you cannot say that
  sentence about your route, it belongs on the active-only resolver.
*/
const EXPECTED_CONFIGURABLE_RESOLVER_CALLERS = [
  "src/app/api/admin/bed-allocation/rooms/bulk/route.ts",
  "src/app/api/admin/bed-allocation/rooms/route.ts",
  "src/app/api/admin/chores/route.ts",
  "src/app/api/admin/lockers/bulk/route.ts",
  "src/app/api/admin/lockers/route.ts",
  "src/app/api/admin/seasons/route.ts",
] as const;

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

describe("only lodge-CONFIGURATION routes use the permissive resolver (#221)", () => {
  const sources = productionSources(join(process.cwd(), "src"));

  it("counts every caller, so a booking route cannot quietly adopt it", () => {
    /*
      Matched at the IMPORT as well as at the call, because a census that only
      recognises one spelling of "uses this helper" is a census with a documented
      way round it. `import { resolveOptionalConfigurableLodgeId as resolveLodge }`
      leaves no `resolveOptionalConfigurableLodgeId(` anywhere in the file, so
      the call-shape pattern alone would report a route that permits inactive
      lodges as not using the permissive resolver at all — the exact drift this
      census exists to catch, arriving through the one edit nobody would think
      to look at.

      Both forms are counted, and either is enough to put the file on the list:
      the alias case is caught at its import, and a file that re-exports without
      calling is still declaring the capability.
    */
    const CALL = /\bresolveOptionalConfigurableLodgeId\s*\(/;
    const IMPORT_SPECIFIER =
      /\bresolveOptionalConfigurableLodgeId\b\s*(?:as\s+\w+)?\s*[,}]/;

    const actual = sources
      .filter((path) => {
        // The helper's own module declares it; every other file that names it
        // is calling it.
        if (repoPath(path) === "src/lib/lodges.ts") return false;
        const source = readFileSync(path, "utf8");
        return CALL.test(source) || IMPORT_SPECIFIER.test(source);
      })
      .map(repoPath)
      .sort();

    expect(actual).toEqual([...EXPECTED_CONFIGURABLE_RESOLVER_CALLERS].sort());
  });

  it("each one is named in the lodge scoping contract", () => {
    // The contract is what a future reader reaches for; a census that agrees
    // with the code but not with the document is half a guard.
    const contract = readFileSync(
      join(process.cwd(), "docs/multi-lodge/lodge-scoping-contract.md"),
      "utf8",
    );
    const section = contract.slice(
      contract.indexOf("## Lodge Creation Defaults"),
      contract.indexOf("## Presentation Rule"),
    );
    expect(section.length).toBeGreaterThan(0);
    for (const caller of EXPECTED_CONFIGURABLE_RESOLVER_CALLERS) {
      // `src/app/api/admin/chores/route.ts` is documented as the ROUTE it
      // serves, which is how the contract names every endpoint.
      const endpoint = caller
        .replace(/^src\/app/, "")
        .replace(/\/route\.ts$/, "");
      expect(section).toContain(endpoint);
    }
  });
});

/*
  THE OTHER HALF OF THE #221 COMPATIBILITY ARGUMENT.

  The create default is a REQUEST-SCHEMA default, so it reaches only callers of
  `POST /api/admin/lodges`. Every other writer of a Lodge row is an install or
  restore path — reproducing a configured club rather than half-configuring a
  new building — and each must keep producing ACTIVE lodges. They all do, and
  they do it by saying `active` explicitly rather than by leaning on the Prisma
  column default, which is what makes that claim durable: it survives a future
  change to `Lodge.active`'s `@default`.

  A source scan rather than a behavioural test on purpose. Running the seeds
  needs a database, and what is being asserted is a property of the code —
  "this writer states its intent" — which a scan states directly and a green
  seed run would only imply.
*/

/** The balanced argument list of the first call to `<needle>` in `source`. */
function callArguments(source: string, needle: string): string {
  const open = source.indexOf(needle);
  expect(open, `${needle} is missing from the file`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open + needle.length - 1; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced parentheses after ${needle}`);
}

const EXPLICIT_ACTIVE_LODGE_WRITERS = [
  {
    file: "prisma/seed.ts",
    call: "prisma.lodge.create(",
    what: "the first-install seed's sole lodge",
  },
  {
    file: "prisma/demo-seed.ts",
    call: "prisma.lodge.create(",
    what: "the optional DEMO_SECOND_LODGE lodge",
  },
  {
    file: "e2e/setup/seed-second-lodge.ts",
    call: "prisma.lodge.upsert(",
    what: "the multi-lodge E2E stack's lodge B, on both the create and update arms",
  },
] as const;

describe("install and restore paths still create ACTIVE lodges (#221)", () => {
  for (const writer of EXPLICIT_ACTIVE_LODGE_WRITERS) {
    it(`${writer.file} states \`active\` rather than leaning on the column default — ${writer.what}`, () => {
      const source = readFileSync(join(process.cwd(), writer.file), "utf8");
      expect(callArguments(source, writer.call)).toMatch(/\bactive:/);
    });
  }

  it("the config-transfer importer writes the active flag the descriptor carries", () => {
    /*
      Its create spreads `buildLodgeData(...)` rather than naming fields at the
      write, so the statement of intent lives one call earlier — and it is not
      "active", it is "whatever the club being restored had", which is the
      right answer for a restore and is unaffected by the #221 create default.

      SAY THE OMITTED CASE OUT LOUD, because it is the one that surprises:
      `coerceBool(undefined)` is `false`, so a descriptor with NO `active` key
      restores an INACTIVE lodge rather than an active one. That is left as it
      is, deliberately. Every descriptor this codebase exports carries the
      field, so an omitted one is hand-authored or foreign, and reading "open
      for booking" out of silence is the unsafe direction — the same reasoning
      that made the create route default to `false` in the first place.
    */
    const source = readFileSync(
      join(process.cwd(), "src/lib/config-transfer/categories/lodge-config.ts"),
      "utf8",
    );
    expect(source).toContain("active: coerceBool(descriptor.active)");
  });

  it("e2e lodge B is active on the UPDATE arm too, not only on create", () => {
    // An upsert that only sets `active` on create would leave a deliberately
    // deactivated lodge B closed for the next run of the stack.
    const source = readFileSync(
      join(process.cwd(), "e2e/setup/seed-second-lodge.ts"),
      "utf8",
    );
    const upsert = callArguments(source, "prisma.lodge.upsert(");
    expect(upsert.match(/\bactive: true\b/g)).toHaveLength(2);
  });
});
