import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatNZDate, formatNZLongDate } from "../nzst-date";

/*
  #2264 — owner decision, 2 August 2026.

  The date sweep moved every hand-rolled `toLocaleDateString` onto the shared
  NZ-pinned helpers. Four of those sites had been rendering the LONG spelled-out
  month ("16 April 2026") and would have silently shortened to the club's medium
  house form ("16 Apr 2026") had they landed on `formatNZDate`. The owner asked
  for the long form to stay on the member-facing surfaces; admin and internal
  screens keep the medium form.

  These are the four. The source-level assertions exist because none of them is
  reachable from a unit test — two are React Server Components, one is a client
  page and one runs jsPDF in the browser — yet the format is exactly the sort of
  thing a later "tidy every date onto formatNZDate" pass would flatten without
  noticing. Asserting on the source is a blunt instrument, but it is the only
  one that fails loudly on that specific regression.
*/

const MEMBER_FACING_LONG_DATE_SITES: ReadonlyArray<{
  what: string;
  file: string;
  mustContain: readonly string[];
}> = [
  {
    what: "the booking messages and emails a member receives",
    file: "src/app/(authenticated)/bookings/[id]/page.tsx",
    mustContain: [
      "checkIn: formatNZLongDate(booking.checkIn)",
      "checkOut: formatNZLongDate(booking.checkOut)",
    ],
  },
  {
    what: "the member lodge-instructions 'last updated' stamp",
    file: "src/app/(authenticated)/lodge-instructions/page.tsx",
    mustContain: ["return formatNZLongDate(new Date(value));"],
  },
  {
    what: "the public hut-leader-instructions 'last updated' stamp",
    file: "src/app/(website)/hut-leader-instructions/hut-leader-instructions-client.tsx",
    mustContain: ["return formatNZLongDate(new Date(value));"],
  },
  {
    what: "the generated report PDF cover",
    file: "src/lib/report-pdf.ts",
    mustContain: ["Generated: ${formatNZLongDate(new Date())}"],
  },
];

describe("member-facing dates keep the long spelled-out month (#2264)", () => {
  it("renders the long form, which is NOT the medium house form", () => {
    // 23:30 UTC on 15 April is 16 April in Auckland, so this also proves the
    // long formatter is club-zone pinned rather than UTC.
    const instant = new Date("2026-04-15T23:30:00.000Z");
    expect(formatNZLongDate(instant)).toBe("16 April 2026");
    expect(formatNZDate(instant)).toBe("16 Apr 2026");
  });

  for (const site of MEMBER_FACING_LONG_DATE_SITES) {
    it(`keeps ${site.what} on formatNZLongDate`, () => {
      const source = readFileSync(join(process.cwd(), site.file), "utf8");
      for (const snippet of site.mustContain) {
        expect(source).toContain(snippet);
      }
    });
  }
});
