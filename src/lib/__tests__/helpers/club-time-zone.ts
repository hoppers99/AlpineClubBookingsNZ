/**
 * The premise guard for a suite whose subject is "the club's calendar day is
 * NOT the UTC day" (#2834, INV-DATE-019).
 *
 * `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`
 * (`src/config/operational.ts`), so setting `TZ=UTC` to imitate the CI runner
 * ALSO moves the club's zone to UTC — docs/TESTING.md rule 6. Every assertion in
 * a suite like this then goes red with a bare `expected '2026-06-14' to be
 * '2026-06-15'`, which reads exactly like the product bug the suite exists to
 * prove fixed. One environment failure that says so is worth more than thirty
 * date mismatches that do not.
 *
 * Call it from the `beforeEach` of the block that pins a divergent instant, so
 * the explanation arrives before any date assertion runs.
 */
import { expect } from "vitest";

import { APP_TIME_ZONE } from "@/config/operational";

export function expectClubTimeZonePremise(): void {
  expect(
    APP_TIME_ZONE,
    "This assertion proves the club's calendar day differs from the UTC day, so it needs the club zone to be New Zealand. APP_TIME_ZONE is being overridden by TZ (or NEXT_PUBLIC_TZ) — see docs/TESTING.md rule 6. This is an environment problem, not the dating bug these tests describe.",
  ).toBe("Pacific/Auckland");
}
