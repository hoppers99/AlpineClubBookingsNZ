import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Census: every place a stay becomes nights is declared here (#2628).
 *
 * `BookingGuestNight` is the canonical night set. `BookingGuest.stayStart` /
 * `stayEnd` is a DERIVED half-open envelope whose `stayEnd` is the morning
 * after the last night (INV-DATE-012). They agree for a contiguous stay; for a
 * SPARSE one the envelope silently fills the internal gaps. Six sites expanded
 * a stay into nights and three of them read the envelope, so a guest booked on
 * nights {1, 3} was reported as awaiting a bed forever, could never reach
 * `"complete"`, and could only ever be checked out once.
 *
 * The fix routed those three at one helper module. The failure mode that comes
 * BACK is a seventh copy: somebody needs a night list, writes
 * `eachDateOnlyInRange(guest.stayStart, guest.stayEnd)` because it is two
 * imports away, and the sparse case is wrong again in a new place. The
 * inventory lived in reviewers' heads, so this file makes it mechanical, in the
 * style of `night-occupancy-census.test.ts` and `api-route-boundaries.test.ts`:
 * a new expansion site has to be classified here or the build fails.
 *
 * ## What this census does and does not guarantee
 *
 * It is a SOURCE-TEXT census over `src/`. It guarantees that no expansion
 * written with `eachDateOnlyInRange` over a `stay*` bound can appear without
 * being declared. It cannot see an expansion that inlines its own day loop, and
 * it does not reach `scripts/` or `prisma/`. That residue is stated rather than
 * implied — but every expansion in the tree today is written the declared way,
 * so the census covers the whole current inventory.
 */

const SRC_ROOT = path.resolve(process.cwd(), "src");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : allSourceFiles(absolute);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

/** `eachDateOnlyInRange(<anything mentioning a stay bound>, …)`, code only. */
const ENVELOPE_EXPANSION = /eachDateOnlyInRange\([^)\n]*stay(?:Start|End)/i;

/**
 * Does any CODE line expand a stay envelope?
 *
 * Line-based on purpose. A whole-file comment strip is not safe here: `src/`
 * holds regex literals and JSX strings containing `/*`, and one of them will
 * happily swallow a real call site and make this census silently pass. Skipping
 * lines that are themselves a comment costs nothing and cannot misfire — the
 * only thing it lets through would be a call sharing a line with a trailing
 * `//`, which is a call, not a comment.
 */
function expandsStayEnvelope(source: string): boolean {
  return source
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        return false;
      }
      return ENVELOPE_EXPANSION.test(line);
    });
}

/**
 * Every declared site, with the evidence that proves what it is.
 *
 * `kind` is the classification and it is the whole point of the table:
 *
 *  - `canonical`   — the one definition. Exactly one of these.
 *  - `booking`     — expands a BOOKING's own `[checkIn, checkOut)`, not a
 *                    guest's stay. A booking has no night set, so there is
 *                    nothing sparse to get wrong.
 *  - `night-set-first` — expands the envelope only as a fallback for a guest
 *                    carrying no `BookingGuestNight` rows, which is exactly
 *                    `getGuestBedNightKeys`'s own rule. Correct as written;
 *                    each one is a local copy that could be routed at the
 *                    helper later, and none may lose its night-set branch.
 */
const EXPANSION_SITES = [
  {
    file: "src/lib/booking-guest-stay-ranges.ts",
    kind: "canonical",
    what: "expandStayEnvelopeToNightKeys — the one definition, half-open by contract",
    evidence: ["export function expandStayEnvelopeToNightKeys("],
  },
  {
    file: "src/lib/admin-bed-allocation.ts",
    kind: "booking",
    what: "an exclusive whole-lodge hold's own booking envelope, clamped to the board window",
    evidence: ["{ stayStart: booking.checkIn, stayEnd: booking.checkOut }"],
  },
  {
    file: "src/app/(authenticated)/bookings/[id]/page.tsx",
    kind: "night-set-first",
    what: "the nights quoted on a member's own consent card",
    evidence: ["viewerConsentGuest.nights.length > 0"],
  },
  {
    file: "src/lib/adult-member-hosting-review.ts",
    kind: "night-set-first",
    what: "hosting participants' nights (INV-HOST-005 states this fallback)",
    evidence: ["guest.nights.length > 0"],
  },
  {
    file: "src/lib/member-guest-consent-notifications.ts",
    kind: "night-set-first",
    what: "the nights named in a member-guest consent email",
    evidence: ["guest.nights.length > 0"],
  },
  {
    file: "src/lib/member-guest-delegate-page.ts",
    kind: "night-set-first",
    what: "the nights shown on the delegate consent page",
    evidence: ["guest.nights.length > 0"],
  },
] as const;

describe("guest stay expansion census (#2628)", () => {
  it("declares every expansion site in the tree", () => {
    const found = allSourceFiles(SRC_ROOT)
      .filter((absolute) => expandsStayEnvelope(fs.readFileSync(absolute, "utf8")))
      .map((absolute) => path.relative(process.cwd(), absolute).replaceAll("\\", "/"))
      .sort();

    expect(found).toEqual(
      EXPANSION_SITES.filter((site) => site.kind !== "canonical")
        .map((site) => site.file)
        .sort(),
    );
  });

  it("keeps each declared site doing what it says it does", () => {
    for (const site of EXPANSION_SITES) {
      const source = readRepoFile(site.file);
      for (const evidence of site.evidence) {
        expect(source, `${site.file} — ${site.what}`).toContain(evidence);
      }
    }
  });

  it("has exactly ONE canonical definition, and it is half-open", () => {
    // The pseudo-guest hazard. Both bed-allocation planners are fed one
    // pseudo-guest per night carrying `stayEnd = night + 1`; an inclusive
    // expansion gives each a phantom second night and the planner claims the
    // morning-after bed. `bed-allocation.test.ts` → "pseudo-guest envelope
    // (#2628)" pins the consequence; this pins the definition.
    const canonical = readRepoFile("src/lib/booking-guest-stay-ranges.ts");
    expect(canonical.split("export function expandStayEnvelopeToNightKeys(")).toHaveLength(2);
    expect(canonical).toContain("key < endKey;");
    expect(canonical).not.toContain("key <= endKey;");
  });

  it("keeps the two deliberate NON-callers of the canonical guest expander", () => {
    // Both feed bed allocation, and both mean something narrower than
    // `getGuestBedNightKeys`. Routing either at it would change behaviour, so
    // they are recorded here rather than left to look like stragglers.
    //
    // The lifecycle reads the explicit rows with NO envelope fallback: its
    // output feeds placement AND the prune diff, so a fallback would place rows
    // the next reconcile sweeps straight off.
    const lifecycle = readRepoFile("src/lib/bed-allocation-lifecycle.ts");
    expect(lifecycle).toContain("function getGuestNightDatesInRange(");
    expect(lifecycle).toContain("return (guest.nights ?? [])");

    // The planner treats an explicitly EMPTY night list as "no demand", which
    // `getGuestBedNightKeys` would read as "use the envelope".
    const planner = readRepoFile("src/lib/bed-allocation.ts");
    expect(planner).toContain("if (guest.nights !== undefined) {");
    expect(planner).toContain(
      "expandStayEnvelopeToNightKeys(guest.stayStart, guest.stayEnd)",
    );
  });

  it("keeps the three repaired surfaces on the canonical helpers", () => {
    // The three that read the envelope and got sparse stays wrong. If any of
    // them re-grows a local expansion, the first test above catches the new
    // call site and this one catches the lost import.
    expect(readRepoFile("src/lib/admin-bed-allocation.ts")).toContain(
      "getExplicitGuestBedNightKeys(guest) ?? []",
    );
    expect(readRepoFile("src/lib/admin-bookings-service.ts")).toContain(
      "getGuestBedNightKeys(guest, booking)",
    );
    expect(readRepoFile("src/lib/lodge-date-scoping.ts")).toContain(
      "isGuestDepartureMorning(guest, date, guest.booking)",
    );
  });
});
