import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Custodian occupancy — write-path contract (#2286).
 *
 * Enforcement is application-code exclusion (owner decision, option (a)): NO
 * database constraint stops a `BedAllocation` row landing on a custodian-held
 * bed-night. The only thing that does is a guard at each write path — so a new
 * write path added later, by someone who has never heard of custodians, would
 * silently punch a hole through the whole feature.
 *
 * This test is that alarm. It enumerates every place in `src/` and `prisma/`
 * that creates or moves a `BedAllocation` onto a bed, and asserts each one is
 * covered by a named mechanism. Adding a new write site fails CI until it is listed here
 * with the mechanism that protects it.
 */

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * Every `.ts`/`.tsx` file under `src/` and `prisma/`, as repo-relative POSIX
 * paths.
 *
 * The scan below used to look at three hand-listed files, which is exactly the
 * hole this test exists to close: a `bedAllocation.create*` added anywhere else
 * — a route handler, a seed, a new service — would never have been seen. The
 * walk is over both trees instead, so a new write site fails CI wherever it
 * lands. Tests are excluded: a mock's `createMany` spy is not a write path.
 */
function allSourceFiles(): string[] {
  const roots = ["src", "prisma"].map((dir) => path.resolve(process.cwd(), dir));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      out.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

/**
 * Every known bed-PLACING write, and how the custodian exclusion reaches it.
 *
 * "Placing" means the statement sets `bedId` to a bed — creating an allocation
 * or moving one. Writes that only touch approval flags, `bedType` or
 * `isSecondOccupant` on a row that is already where it is are NOT placements
 * and are deliberately absent (they cannot introduce an occupant onto a held
 * bed-night).
 */
const GUARDED_WRITE_SITES: Array<{
  file: string;
  statement: string;
  mechanism: string;
  /**
   * A string that must appear in the file for the mechanism to be real.
   *
   * Matched with runs of whitespace collapsed on BOTH sides (see
   * `containsEvidence`), so a reformat — Prettier-on-save wrapping a long call
   * across lines is the obvious one — cannot fail this test with a message
   * about a missing custodian guard when the guard is perfectly intact. The
   * evidence names the mechanism; it is not a formatting pin.
   */
  evidence: string;
}> = [
  {
    file: "src/lib/admin-bed-allocation.ts",
    statement: "bedAllocation.upsert",
    mechanism:
      "allocateBedNight calls assertBedNightsFreeOfCustodianHold before the upsert; every manual placement (single night, bulk drop, board move) funnels through it.",
    evidence: "await assertBedNightsFreeOfCustodianHold({",
  },
  {
    file: "src/lib/admin-bed-allocation.ts",
    statement: "bedAllocation.createMany",
    mechanism:
      "runAutoBedAllocation re-filters its suggestions against custodianHeldBedNightKeys inside its locked transaction; runAssignBedRangeAttempt classifies held nights as the CUSTODIAN_HOLD refusal category before writing anything.",
    evidence: "custodianHeldBedNightKeys(",
  },
  {
    file: "src/lib/admin-bed-allocation.ts",
    statement: "bedAllocation.updateMany",
    mechanism:
      "The range path's batched updateMany only ever runs for targetNights with no refusal, and CUSTODIAN_HOLD is one of the refusal categories.",
    evidence: 'category: "CUSTODIAN_HOLD"',
  },
  {
    file: "src/lib/bed-allocation-lifecycle.ts",
    statement: "bedAllocation.createMany",
    mechanism:
      "autoAllocateMissingBedNights feeds custodian holds to the planner as #1768 unknown-occupant rows (blocking, never evictable), AND re-filters the payload against the live holds on the writing client immediately before both createManys — the reconcile is routinely called post-commit and unlocked, so the plan-time read alone would let a hold created in between be written over.",
    evidence: "dropRowsOnCustodianHeldBedNights(client, rows",
  },
  {
    file: "src/lib/bed-allocation-lifecycle.ts",
    statement: "bedAllocation.updateMany",
    mechanism:
      "The displacement MOVE writes `bedId: displacement.toBedId`, and every displacement comes from the same planner run that was fed the custodian holds as never-evictable unknown occupants — so a MOVE can never target a held bed-night either.",
    evidence:
      "bedId: displacement.toBedId,\n            roomId: displacement.toRoomId,",
  },
  {
    file: "prisma/demo-seed.ts",
    statement: "bedAllocation.create",
    mechanism:
      "The demo seed builds a fresh demo database from nothing: it creates its own rooms, beds and bookings and creates NO HutLeaderAssignment with a bedId, so there is no hold for it to write over. Listed rather than excluded so that adding a seeded custodian hold later forces whoever does it to re-read this entry and order the seed correctly.",
    evidence: "bedAllocation.create({",
  },
  {
    file: "src/lib/bed-allocation.ts",
    statement: "bedAllocation.createMany",
    mechanism:
      "replaceBedAllocationsForBooking is a DORMANT test seam with no production caller. It is listed so it can never be revived unguarded: reviving it means giving it a guard and updating this entry.",
    evidence: "// test seam",
  },
];

/**
 * The whole-lodge-hold half of the same contract (#2317).
 *
 * `dropRowsOn…`/`findBlockingWholeLodgeHolds` at a write path is what makes
 * DOMAIN_INVARIANTS' "both writers re-read the live holds immediately before
 * writing" a machine-checked claim rather than prose. Only the AUTOMATIC
 * placers appear: manual placement is deliberately never refused for a
 * whole-lodge hold (ADR-001 decision 1 hands the overlap to the officer), which
 * is the one place the two exclusions differ.
 */
const WHOLE_LODGE_GUARDED_WRITE_SITES: Array<{
  file: string;
  statement: string;
  mechanism: string;
  evidence: string;
}> = [
  {
    file: "src/lib/admin-bed-allocation.ts",
    statement: "bedAllocation.createMany",
    mechanism:
      "runAutoBedAllocation feeds the blocking holds to the planner as #1768 unknown-occupant rows AND re-reads them on the transaction client inside its locked transaction, dropping any suggestion landing on a held lodge-night.",
    evidence: "await findBlockingWholeLodgeHolds({",
  },
  {
    file: "src/lib/bed-allocation-lifecycle.ts",
    statement: "bedAllocation.createMany",
    mechanism:
      "autoAllocateMissingBedNights feeds the blocking holds to the planner AND re-filters the payload against the live holds on the writing client immediately before the createMany — the reconcile is routinely called post-commit and unlocked, so the plan-time read alone would let a hold created in between be written over.",
    evidence: "return dropRowsOnWholeLodgeHeldNights(client, offCustodianHolds, {",
  },
  {
    file: "src/lib/bed-allocation-lifecycle.ts",
    statement: "bedAllocation.updateMany",
    mechanism:
      "The displacement MOVE writes `bedId: displacement.toBedId`, and a displacement is applied only when the RE-CHECKED payload still claims the bed-night it frees — so a MOVE cannot survive the re-filter that dropped the row it was clearing the way for.",
    evidence: "const applicable = justifiedDisplacements(data);",
  },
];

/**
 * Whitespace-insensitive substring match — see the `evidence` note above.
 *
 * Whitespace is stripped entirely rather than collapsed, because a formatter
 * does not only wrap lines: it also adds and removes spaces inside argument
 * lists and braces. None of the evidence strings depend on whitespace inside a
 * string literal, so this costs nothing and removes the whole class of
 * "reformatting fails the guard test" false alarms.
 */
function containsEvidence(source: string, evidence: string): boolean {
  const squash = (value: string) => value.replace(/\s+/g, "");
  return squash(source).includes(squash(evidence));
}

describe("custodian write-path contract (#2286)", () => {
  it("covers every BedAllocation write site that places a guest on a bed", () => {
    // Rebuild the enumeration from the WHOLE source tree rather than trusting
    // the list above — or a hand-picked list of three files.
    const files = allSourceFiles();
    const found = new Set<string>();
    for (const file of files) {
      const source = readRepoFile(file);
      for (const statement of ["create", "createMany", "upsert", "updateMany"]) {
        // `updateMany` on isSecondOccupant / bedType / approval fields is not a
        // placement; only count an updateMany whose data names a bed.
        const pattern = new RegExp(
          `bedAllocation\\.${statement}\\(\\{([\\s\\S]{0,400}?)\\n\\s*\\}\\)`,
          "g",
        );
        for (const match of source.matchAll(pattern)) {
          const body = match[1];
          const placesABed =
            statement !== "updateMany" ? true : /bedId:/.test(body);
          if (placesABed) found.add(`${file}::bedAllocation.${statement}`);
        }
      }
    }

    const declared = new Set(
      GUARDED_WRITE_SITES.map((site) => `${site.file}::${site.statement}`),
    );
    const undeclared = [...found].filter((key) => !declared.has(key)).sort();

    expect(
      undeclared,
      "A BedAllocation write path is not covered by the custodian exclusion. " +
        "Enforcement is application-code only (#2286, option (a)) — there is no " +
        "database constraint behind it. Add the guard, then list the site in " +
        "GUARDED_WRITE_SITES with the mechanism that protects it.",
    ).toEqual([]);
  });

  it("keeps each declared mechanism actually present in its file", () => {
    for (const site of GUARDED_WRITE_SITES) {
      const source = readRepoFile(site.file);
      expect(
        containsEvidence(source, site.evidence),
        `${site.file} no longer contains the evidence for: ${site.mechanism}`,
      ).toBe(true);
    }
  });

  it("keeps the whole-lodge-hold exclusion on the same write paths", () => {
    // #2317 extended the same application-code-only pattern to exclusive
    // whole-lodge holds: no database constraint stands behind THAT exclusion
    // either, and it covers every bed of a lodge rather than one bed-night, so
    // a write path that loses the guard loses far more. Enumerated separately
    // from GUARDED_WRITE_SITES because the two exclusions do not cover the same
    // set of writes: manual placement is deliberately NOT refused for a
    // whole-lodge hold (ADR-001 decision 1 keeps the overlap officer-resolved),
    // whereas it is for a custodian hold.
    for (const site of WHOLE_LODGE_GUARDED_WRITE_SITES) {
      const source = readRepoFile(site.file);
      expect(
        containsEvidence(source, site.evidence),
        `${site.file} no longer contains the evidence for: ${site.mechanism}`,
      ).toBe(true);
    }
  });

  it("keeps the manual funnel guarded BEFORE it resolves sharing or upserts", () => {
    const source = readRepoFile("src/lib/admin-bed-allocation.ts");
    const funnel = source.slice(
      source.indexOf("async function allocateBedNight("),
      source.indexOf("export async function manuallyAllocateBed("),
    );
    const guardAt = funnel.indexOf("assertBedNightsFreeOfCustodianHold");
    const upsertAt = funnel.indexOf("bedAllocation.upsert");
    expect(guardAt).toBeGreaterThan(-1);
    expect(upsertAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(upsertAt);
  });

  it("keeps utilisation reporting deliberately custodian-FREE, with the reason at the loop", () => {
    // The include/exclude split is a decision, not an accident
    // (docs/CAPACITY_MODEL.md): every ADMISSION path and the capacity-warnings
    // cron count the custodian; the utilisation report does not, because it
    // measures how much the lodge was BOOKED. Pinned here so a later "fix" that
    // adds the custodian to the report has to change this test and re-read the
    // decision first.
    const reports = readRepoFile("src/app/api/admin/reports/route.ts");
    expect(reports).not.toContain("custodian-occupancy");
    expect(reports).toContain("deliberately EXCLUDED");

    // And the other way round: the cron DOES count it.
    const cron = readRepoFile("src/lib/cron-capacity-warnings.ts");
    expect(cron).toContain("buildLodgeCustodianNightCounter");
  });

  it("takes the per-lodge advisory lock in every self-wrapped placement transaction", () => {
    const source = readRepoFile("src/lib/admin-bed-allocation.ts");
    // The guard's read and the write must sit inside the SAME lock the
    // custodian-hold writer takes, or the exclusion is racy by construction.
    expect(source).toContain("acquireLodgeCapacityLock");
    expect(source).toContain("resolveBedLodgeIdForLock");
    // runAutoBedAllocation was transaction-free and lock-free before #2286.
    const autoRun = source.slice(
      source.indexOf("export async function runAutoBedAllocation("),
      source.indexOf("async function assertGuestAndBedForAllocation("),
    );
    expect(autoRun).toContain("acquireLodgeCapacityLock(tx, lodgeId)");
    expect(autoRun).toContain("prisma.$transaction");
  });

  it("keeps existing-allocation moves global-then-destination locked, date-preserving and on the guarded manual funnel", () => {
    const source = readRepoFile("src/lib/admin-bed-allocation.ts");
    const lockHeldMove = source.slice(
      source.indexOf(
        "export async function moveBedAllocationsSameDateWithLocksHeld(",
      ),
      source.indexOf("export async function moveBedAllocationsSameDate("),
    );
    const move = source.slice(
      source.indexOf("export async function moveBedAllocationsSameDate("),
      source.indexOf("interface BulkAllocationConflict"),
    );
    const wrapper = move.slice(
      move.indexOf("// Only the destination bed is read before the transaction"),
    );

    expect(wrapper.indexOf("resolveBedLodgeIdForLock(input.bedId, prisma)"))
      .toBeLessThan(wrapper.indexOf("prisma.$transaction"));
    expect(wrapper.indexOf("pg_advisory_xact_lock(1)"))
      .toBeLessThan(wrapper.indexOf("acquireLodgeCapacityLock(tx, lockLodgeId)"));
    expect(wrapper.indexOf("acquireLodgeCapacityLock(tx, lockLodgeId)"))
      .toBeLessThan(
        wrapper.indexOf(
          "return moveBedAllocationsSameDateWithLocksHeld({ ...input, db: tx })",
        ),
      );
    expect(lockHeldMove).toContain("return moveUnderLock(input.db)");
    expect(lockHeldMove).toContain("db.bedAllocation.findMany");
    expect(lockHeldMove).toContain("stayDate: formatDateOnly(source.stayDate)");
    expect(lockHeldMove).toContain("await manuallyAllocateBedWithLocksHeld({");
    expect(move).toContain("pg_advisory_xact_lock(1)");
  });
});
