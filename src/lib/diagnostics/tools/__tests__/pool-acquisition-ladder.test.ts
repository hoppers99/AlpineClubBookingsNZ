/**
 * THE RUNG THE LADDER DID NOT HAVE (#2804).
 *
 * `types.ts` derives four bounds for a `server_owned` read and asserts their order.
 * All four were satisfied by a first draft that could not work, because the FIRST
 * bound on any pooled read is not in that file and is not Prisma's: pg's own
 * `connectionTimeoutMillis`, set from `pool_timeout` in `DATABASE_URL` and applied
 * to time spent QUEUED as well as time spent connecting.
 *
 * That draft set `maxWait` to 20 000 against a production pool ceiling of 10 000.
 * The consequence was not a slower refusal — it was a refusal that never used the
 * new budget at all: pg rejected at ~10 s with a bare `Error` carrying no code, so
 * the wait the owner had approved never happened AND the "the database is just
 * busy" classification could never fire. Every unit test passed, because they
 * hand-build the error object rather than provoking one.
 *
 * So the invariant is asserted here, against the REAL connection strings this
 * application ships with. Raising the diagnostics wait without raising the pool is
 * now a failing test rather than a claim in a docblock — and raising the pool is a
 * whole-application decision, because that pool serves member traffic too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePoolAcquisitionTimeoutMillis } from "@/lib/prisma-adapter";

import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

/**
 * Every application `DATABASE_URL` this repository ships, read from the compose
 * file rather than restated — a restated URL is one more thing that can drift from
 * the one that actually runs, which is the failure this whole file is about.
 *
 * The diagnostics SELECT-only URL is deliberately excluded: it is a different pool
 * on a different role, and the seam does not use it.
 */
function shippedApplicationDatabaseUrls(): string[] {
  const compose = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");
  // To END OF LINE, not to the first space: the compose values interpolate
  // `${DB_PASSWORD:?DB_PASSWORD is required}`, which CONTAINS spaces. A `\S+`
  // pattern truncates there and silently drops the query string — which is the
  // only part this file cares about. The first version of this helper did exactly
  // that, and the "not vacuous" test above is what caught it.
  const urls = [
    ...compose.matchAll(/DATABASE_URL:[ 	]*(postgresql:\/\/.+)/g),
  ].map((match) =>
    // Substitute the shell interpolation for something parseable. Only the query
    // string is read; the credentials are irrelevant and must not be echoed.
    match[1].replace(/\$\{[^}]*\}/g, "placeholder").trim(),
  );
  return urls;
}

describe("the pool's own acquisition timeout bounds the diagnostics wait (#2804)", () => {
  it("finds the shipped connection strings, so the assertions below are not vacuous", () => {
    const urls = shippedApplicationDatabaseUrls();
    expect(urls.length).toBeGreaterThan(0);
    // Every one of them must actually declare the option, or `resolveTimeoutMillis`
    // silently falls back to its 5 000 default and this file would be asserting
    // against a number nothing uses.
    for (const url of urls) {
      expect(url, url).toMatch(/pool_timeout=|connect_timeout=/);
    }
  });

  it.each(shippedApplicationDatabaseUrls())(
    "keeps the diagnostics wait strictly under the pool ceiling: %s",
    (url) => {
      const poolCeilingMs = resolvePoolAcquisitionTimeoutMillis(url);

      // STRICTLY under, not equal. The two timers start together; at equality it is
      // a race, and the loser is the one that produces a classifiable error. The
      // margin is what makes `P2028` — and therefore `evidence_database_busy` —
      // the outcome an operator actually gets.
      expect(
        DIAGNOSTICS_TOOL_BOUNDS.readOnlyMaxWaitMs,
        `${url} allows only ${poolCeilingMs}ms in the pool queue, so a diagnostics maxWait of ${DIAGNOSTICS_TOOL_BOUNDS.readOnlyMaxWaitMs}ms can never be reached. Lower the wait, or raise pool_timeout — but that pool serves member traffic, so raising it is a whole-application decision.`,
      ).toBeLessThan(poolCeilingMs);
    },
  );

  it("leaves enough margin that the pool cannot win the race by a rounding error", () => {
    const ceilings = shippedApplicationDatabaseUrls().map(
      resolvePoolAcquisitionTimeoutMillis,
    );
    const tightest = Math.min(...ceilings);

    // A token 1 ms gap would satisfy "strictly less" and still be a coin toss under
    // load. A second is the smallest gap worth calling deliberate.
    expect(tightest - DIAGNOSTICS_TOOL_BOUNDS.readOnlyMaxWaitMs).toBeGreaterThanOrEqual(
      1_000,
    );
  });
});
