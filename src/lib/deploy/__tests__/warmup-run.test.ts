import { describe, expect, it, vi } from "vitest";
import type { PlannedWarmupRoute } from "../warmup-route-policy";
import { nonceConsistencyProblem, runWarmup } from "../warmup-run";

/**
 * The warm-up requests themselves (#2566): where they go, what they carry, and what
 * counts as proof that a page is stored.
 *
 * `fetch` is injected, so every case here is about the RULES rather than about a
 * real server. The production-shaped half — a real container, a real ISR store,
 * real `x-nextjs-cache` headers — is `e2e/deploy-warmup.spec.ts`, because the
 * owner's decision is explicit that unit tests of the route list are not enough.
 */

const HTML = `<!doctype html><html><head><script nonce="abc123">window.x=1</script></head><body>page</body></html>`;
const POLICY = "default-src 'self'; script-src 'self' 'nonce-abc123'";

function route(
  overrides: Partial<PlannedWarmupRoute> = {},
): PlannedWarmupRoute {
  return {
    path: "/about",
    tier: "cms",
    cacheClass: "isr",
    source: "published-cms-page",
    why: "a published page",
    ...overrides,
  };
}

interface FakeResponseSpec {
  status?: number;
  cache?: string | null;
  prerender?: string | null;
  contentType?: string | null;
  body?: string;
  location?: string | null;
  policy?: string | null;
  throws?: Error;
}

/**
 * A response in the shape next@16.2.12 really sends.
 *
 * The pairing is not optional and that is the point of doing it here: an `x-nextjs-cache`
 * header always arrives WITH `x-nextjs-prerender: 1`, because
 * `build/templates/app-page.js` sets both inside one `if (isSSG …)` block whatever the
 * cache result was. So a spec that names a cache value gets the prerender header too
 * unless it says otherwise, and a fixture modelling a shape the release cannot emit —
 * the reason the store-verification rule was pinned against the wrong response and
 * passed while production would have shipped an empty page cache — is no longer
 * something this helper can produce by omission.
 */
function fakeResponse(spec: FakeResponseSpec): Response {
  const headers = new Headers();
  if (spec.cache !== null && spec.cache !== undefined) {
    headers.set("x-nextjs-cache", spec.cache);
  }
  const prerender =
    spec.prerender === undefined && spec.cache
      ? "1"
      : (spec.prerender ?? undefined);
  if (prerender !== undefined) {
    headers.set("x-nextjs-prerender", prerender);
  }
  headers.set("content-type", spec.contentType ?? "text/html; charset=utf-8");
  if (spec.location) {
    headers.set("location", spec.location);
  }
  headers.set("content-security-policy", spec.policy ?? POLICY);

  return new Response(spec.body ?? HTML, {
    status: spec.status ?? 200,
    headers,
  });
}

/** A fetch that answers the given specs in order, then repeats the last one. */
function scriptedFetch(specs: FakeResponseSpec[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let index = 0;

  const impl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const spec = specs[Math.min(index, specs.length - 1)];
      index += 1;
      calls.push({
        url: String(url),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
      });

      if (spec.throws) {
        throw spec.throws;
      }

      return fakeResponse(spec);
    },
  );

  return { impl: impl as unknown as typeof fetch, calls };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    origin: "http://127.0.0.1:3000",
    hostHeader: "bookings.example.nz",
    concurrency: 2,
    requestTimeoutMs: 5_000,
    totalTimeoutMs: 60_000,
    sleep: async () => {},
    ...overrides,
  } as Parameters<typeof runWarmup>[1];
}

describe("runWarmup — a stored route", () => {
  it("renders cold and then verifies the page really was stored", async () => {
    const fetcher = scriptedFetch([{ cache: "MISS" }, { cache: "HIT" }]);

    const report = await runWarmup(
      [route()],
      options({ fetchImpl: fetcher.impl }),
    );

    expect(report.results[0].outcome).toBe("warmed");
    expect(report.results[0].rendered).toBe(true);
    expect(report.results[0].cacheApplicable).toBe(true);
    expect(report.results[0].cacheVerified).toBe(true);
    expect(report.results[0].requests).toBe(2);
  });

  it("fails a route that answers 200 for ever but never reports a store", async () => {
    // The owner's case: "If pages return successfully but repeated requests show
    // that the cache is not being populated, treat this as a systemic warm-up
    // failure." A 200-only checker would have called this a pass.
    //
    // The fixture sends BOTH headers, which is what a real ISR route emits on a MISS
    // (next@16.2.12 sets `x-nextjs-prerender: 1` in the same block as
    // `x-nextjs-cache`, hit and miss alike). An earlier version of this case omitted
    // the prerender header, so it modelled a response shape the release never sends
    // and passed while production would have been certified warm with an empty store.
    const fetcher = scriptedFetch([{ cache: "MISS", prerender: "1" }]);

    const report = await runWarmup(
      [route()],
      options({ fetchImpl: fetcher.impl }),
    );

    expect(report.results[0].outcome).toBe("failed");
    expect(report.results[0].failure?.kind).toBe("cache-not-stored");
    expect(report.results[0].rendered).toBe(true);
    expect(report.results[0].cacheVerified).toBe(false);
    expect(report.results[0].cacheHeader).toBe("MISS");
  });

  it("never lets the prerender header override a MISS", async () => {
    // The regression this pins is the whole issue's point of failure: with
    // `x-nextjs-prerender: 1` accepted as an equivalent indicator, a release whose
    // page store never populates reported "N of N confirmed stored" and the gate
    // returned `pass`.
    const everyResponseMisses = scriptedFetch([
      { cache: "MISS", prerender: "1" },
      { cache: "MISS", prerender: "1" },
      { cache: "MISS", prerender: "1" },
    ]);

    const report = await runWarmup(
      [route()],
      options({ fetchImpl: everyResponseMisses.impl }),
    );

    expect(report.results[0].cacheVerified).toBe(false);
    expect(report.results[0].failure?.kind).toBe("cache-not-stored");
  });

  it("does not accept REVALIDATED as proof of a store", async () => {
    // It means the response was regenerated because that request asked for on-demand
    // revalidation — a fresh render, not a reused one. A warm-up request never asks,
    // so seeing it means something else is driving the store and the gate has proved
    // nothing.
    const fetcher = scriptedFetch([
      { cache: "MISS", prerender: "1" },
      { cache: "REVALIDATED", prerender: "1" },
    ]);

    const report = await runWarmup(
      [route()],
      options({ fetchImpl: fetcher.impl }),
    );

    expect(report.results[0].cacheVerified).toBe(false);
  });

  it("accepts a page whose store reports STALE, and re-checks a MISS once", async () => {
    const stale = await runWarmup(
      [route()],
      options({
        fetchImpl: scriptedFetch([
          { cache: "MISS", prerender: "1" },
          { cache: "STALE", prerender: "1" },
        ]).impl,
      }),
    );
    expect(stale.results[0].cacheVerified).toBe(true);

    const recheck = scriptedFetch([
      { cache: "MISS", prerender: "1" },
      { cache: "MISS", prerender: "1" },
      { cache: "HIT", prerender: "1" },
    ]);
    const eventual = await runWarmup(
      [route()],
      options({ fetchImpl: recheck.impl }),
    );
    expect(eventual.results[0].cacheVerified).toBe(true);
    expect(eventual.results[0].requests).toBe(3);
  });

  it("accepts the prerender header ONLY when there is no cache header at all", async () => {
    // Next omits `x-nextjs-cache` in minimal mode, where the prerender header is the
    // only indicator that exists. This deployment does not run minimal mode, so the
    // branch is unreachable in production and is kept so a hosting change degrades to
    // "verified" rather than to a gate nobody can get past.
    const minimalMode = scriptedFetch([
      { cache: null, prerender: "1" },
      { cache: null, prerender: "1" },
    ]);

    const report = await runWarmup(
      [route()],
      options({ fetchImpl: minimalMode.impl }),
    );

    expect(report.results[0].cacheVerified).toBe(true);
  });
});

describe("runWarmup — a per-request route", () => {
  const perRequest = route({
    path: "/",
    tier: "critical",
    cacheClass: "render-only",
    source: "critical-list",
  });

  it("warms it with one request and expects no cache indicator", async () => {
    const fetcher = scriptedFetch([{ cache: null }]);

    const report = await runWarmup(
      [perRequest],
      options({ fetchImpl: fetcher.impl }),
    );

    expect(report.results[0].outcome).toBe("warmed");
    expect(report.results[0].cacheApplicable).toBe(false);
    expect(report.results[0].requests).toBe(1);
  });

  it("fails it when the release has started storing it", async () => {
    // #2352's hazard inverted: a per-request page that is stored freezes one
    // visitor's render — and its per-request nonce — for everyone after them.
    const fetcher = scriptedFetch([{ cache: "HIT" }]);

    const report = await runWarmup(
      [perRequest],
      options({ fetchImpl: fetcher.impl }),
    );

    expect(report.results[0].failure?.kind).toBe("unexpected-cache-header");
  });
});

describe("runWarmup — a build-time route", () => {
  const prebuilt = route({
    path: "/",
    tier: "critical",
    cacheClass: "prebuilt",
    source: "critical-list",
  });

  it("accepts the cache headers a build-time page really carries", async () => {
    // A prebuilt page is `isSSG`, so next sets BOTH headers on it — typically
    // `x-nextjs-cache: HIT`. Requiring their absence, as the `render-only` rule does,
    // failed every such route as a release-wide fault the moment one existed: #2352
    // slice 3 makes a warmed public address build-time prerendered, and the operator
    // would have been told the release "is storing a page rendered for one visitor".
    const fetcher = scriptedFetch([{ cache: "HIT", prerender: "1" }]);

    const report = await runWarmup(
      [prebuilt],
      options({ fetchImpl: fetcher.impl }),
    );

    expect(report.results[0].outcome).toBe("warmed");
    expect(report.results[0].failure).toBeUndefined();
    // There is no store for THIS gate to populate, so nothing is verified — and one
    // request is all it costs.
    expect(report.results[0].cacheApplicable).toBe(false);
    expect(report.results[0].cacheHeader).toBe("HIT");
    expect(report.results[0].requests).toBe(1);
  });

  it("still fails a build-time page that renders a broken document", async () => {
    const report = await runWarmup(
      [prebuilt],
      options({
        fetchImpl: scriptedFetch([
          {
            cache: "HIT",
            prerender: "1",
            policy: "script-src 'self' 'nonce-DIFFERENT'",
          },
        ]).impl,
      }),
    );

    expect(report.results[0].failure?.kind).toBe("nonce-mismatch");
  });
});

describe("runWarmup — failure classification", () => {
  it("refuses to follow a redirect and names one to login separately", async () => {
    const away = await runWarmup(
      [route()],
      options({
        fetchImpl: scriptedFetch([
          { status: 307, location: "https://elsewhere.example/" },
        ]).impl,
      }),
    );
    expect(away.results[0].failure?.kind).toBe("unexpected-redirect");

    const login = await runWarmup(
      [route()],
      options({
        fetchImpl: scriptedFetch([
          { status: 302, location: "/login?from=%2Fabout" },
        ]).impl,
      }),
    );
    expect(login.results[0].failure?.kind).toBe("redirect-to-login");
  });

  it("reports a 500 as a server error and does not retry it", async () => {
    const fetcher = scriptedFetch([{ status: 500, body: "boom" }]);

    const report = await runWarmup(
      [route()],
      options({ fetchImpl: fetcher.impl }),
    );

    expect(report.results[0].failure?.kind).toBe("server-error");
    expect(report.results[0].requests).toBe(1);
  });

  it("reports an unexpected status and an unusable body", async () => {
    const odd = await runWarmup(
      [route()],
      options({ fetchImpl: scriptedFetch([{ status: 418 }]).impl }),
    );
    expect(odd.results[0].failure?.kind).toBe("unexpected-status");

    const empty = await runWarmup(
      [route()],
      options({
        fetchImpl: scriptedFetch([
          { status: 200, body: "", contentType: "text/html" },
        ]).impl,
      }),
    );
    expect(empty.results[0].failure?.kind).toBe("invalid-response");

    const json = await runWarmup(
      [route()],
      options({
        fetchImpl: scriptedFetch([
          { status: 200, body: '{"ok":true}', contentType: "application/json" },
        ]).impl,
      }),
    );
    expect(json.results[0].failure?.kind).toBe("invalid-response");
  });

  it("distinguishes a page unpublished mid-run from an unexpected 404", async () => {
    const unpublished = await runWarmup(
      [route()],
      options({
        fetchImpl: scriptedFetch([{ status: 404 }]).impl,
        isStillPublished: async () => false,
      }),
    );
    expect(unpublished.results[0].outcome).toBe("unpublished-during-warmup");
    expect(unpublished.results[0].failure).toBeUndefined();

    const missing = await runWarmup(
      [route()],
      options({
        fetchImpl: scriptedFetch([{ status: 404 }]).impl,
        isStillPublished: async () => true,
      }),
    );
    expect(missing.results[0].failure?.kind).toBe("unexpected-404");
  });

  it("never treats a critical 404 on a BUILT page as a publishing race", async () => {
    const report = await runWarmup(
      [
        route({
          path: "/join",
          tier: "critical",
          cacheClass: "render-only",
          source: "critical-list",
        }),
      ],
      options({
        fetchImpl: scriptedFetch([{ status: 404 }]).impl,
        isStillPublished: async () => false,
      }),
    );

    expect(report.results[0].failure?.kind).toBe("unexpected-404");
  });

  it("treats the promoted Book Now target as the CMS page it is, not as a critical 404", async () => {
    // The one CMS page the plan carries at critical tier. Gating the re-check on the
    // TIER made an admin unpublishing it mid-run block a production cutover on a page
    // that was answering correctly — and nothing public is broken in that state,
    // because the button's #1929 fail-open contract requires `published` and falls
    // back to the member booking flow.
    const raced = await runWarmup(
      [
        route({
          path: "/how-booking-works",
          tier: "critical",
          cacheClass: "isr",
          source: "book-now-target",
        }),
      ],
      options({
        fetchImpl: scriptedFetch([{ status: 404 }]).impl,
        isStillPublished: async () => false,
      }),
    );

    expect(raced.results[0].outcome).toBe("unpublished-during-warmup");
    expect(raced.results[0].failure).toBeUndefined();

    // And a 404 on a target that IS still published is still a real failure.
    const genuinelyMissing = await runWarmup(
      [
        route({
          path: "/how-booking-works",
          tier: "critical",
          cacheClass: "isr",
          source: "book-now-target",
        }),
      ],
      options({
        fetchImpl: scriptedFetch([{ status: 404 }]).impl,
        isStillPublished: async () => true,
      }),
    );

    expect(genuinelyMissing.results[0].failure?.kind).toBe("unexpected-404");
  });

  it("retries a transient transport failure once, then gives up", async () => {
    const flaky = scriptedFetch([
      { throws: new TypeError("fetch failed") },
      { cache: "MISS" },
      { cache: "HIT" },
    ]);
    const recovered = await runWarmup(
      [route()],
      options({ fetchImpl: flaky.impl }),
    );
    expect(recovered.results[0].outcome).toBe("warmed");
    expect(recovered.results[0].requests).toBe(3);

    const dead = scriptedFetch([{ throws: new TypeError("fetch failed") }]);
    const gaveUp = await runWarmup(
      [route()],
      options({ fetchImpl: dead.impl }),
    );
    expect(gaveUp.results[0].failure?.kind).toBe("unreachable");
    // One attempt plus one retry, and no more: a persistent failure is not hidden
    // by repetition.
    expect(gaveUp.results[0].requests).toBe(2);
  });

  it("reports a per-request timeout as a timeout", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";

    const report = await runWarmup(
      [route()],
      options({ fetchImpl: scriptedFetch([{ throws: abort }]).impl }),
    );

    expect(report.results[0].failure?.kind).toBe("timeout");
  });

  it("fails a stored page whose nonce does not match its own policy", async () => {
    const fetcher = scriptedFetch([
      { cache: "MISS" },
      {
        cache: "HIT",
        policy: "script-src 'self' 'nonce-DIFFERENT'",
      },
    ]);

    const report = await runWarmup(
      [route()],
      options({ fetchImpl: fetcher.impl }),
    );

    expect(report.results[0].failure?.kind).toBe("nonce-mismatch");
  });
});

describe("runWarmup — request shape", () => {
  it("asks the target's own origin, with the production host forwarded", async () => {
    const fetcher = scriptedFetch([{ cache: "MISS" }, { cache: "HIT" }]);

    await runWarmup(
      [route({ path: "/te-reo-m%C4%81ori" })],
      options({ fetchImpl: fetcher.impl }),
    );

    expect(fetcher.calls[0].url).toBe(
      "http://127.0.0.1:3000/te-reo-m%C4%81ori",
    );
    // `x-forwarded-host` is the one that reaches the release and the one this codebase
    // reads; `host` is set for intent and is overwritten by the HTTP client with the
    // URL authority. Both are asserted on the INIT object here, which is all a unit
    // test can see — the wire behaviour is measured and recorded in the module header,
    // and `warmup-host-header-contract.test.ts` holds the assumption that makes the
    // forwarded header sufficient.
    expect(fetcher.calls[0].headers.host).toBe("bookings.example.nz");
    expect(fetcher.calls[0].headers["x-forwarded-host"]).toBe(
      "bookings.example.nz",
    );
    expect(fetcher.calls[0].headers["x-forwarded-proto"]).toBe("https");
    // Never a client address: getClientIp() trusts the rightmost forwarded value.
    expect(fetcher.calls[0].headers["x-forwarded-for"]).toBeUndefined();
  });
});

describe("runWarmup — bounds", () => {
  it("keeps concurrency at or below the configured limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const impl = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      inFlight -= 1;
      return fakeResponse({ cache: "HIT" });
    }) as unknown as typeof fetch;

    const routes = Array.from({ length: 12 }, (_, index) =>
      route({ path: `/page-${index}` }),
    );

    const report = await runWarmup(
      routes,
      options({ fetchImpl: impl, concurrency: 3 }),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(report.peakConcurrency).toBeLessThanOrEqual(3);
    expect(report.results).toHaveLength(12);
  });

  it("marks routes the overall deadline never reached as failures, not passes", async () => {
    let clock = 0;
    const impl = (async () => {
      clock += 400;
      return fakeResponse({ cache: "HIT" });
    }) as unknown as typeof fetch;

    const routes = Array.from({ length: 5 }, (_, index) =>
      route({ path: `/page-${index}` }),
    );

    const report = await runWarmup(
      routes,
      options({
        fetchImpl: impl,
        concurrency: 1,
        totalTimeoutMs: 1_000,
        monotonicNow: () => clock,
      }),
    );

    expect(report.deadlineExpired).toBe(true);
    const notAttempted = report.results.filter(
      (result) => result.failure?.kind === "not-attempted",
    );
    expect(notAttempted.length).toBeGreaterThan(0);
    expect(report.results.every((result) => result !== undefined)).toBe(true);
  });

  it("blames the deadline, not the release, when time runs out before the store is verified", async () => {
    // The render succeeded and reported MISS; the deadline then expired, so the
    // VERIFICATION request was never sent. `requestWithTransientRetry` returns its
    // zero-request stub for that, and the stub carries `transportError:
    // "unreachable"` — so without the requests===0 guard this was reported as "the
    // release stopped answering while the store was being verified" (a release fault
    // an operator would go hunting for) and, because the kind was `unreachable`
    // rather than `not-attempted`, the run summary said `deadlineExpired: false` and
    // denied the cause outright.
    let clock = 0;
    const fetcher = scriptedFetch([{ cache: "MISS" }, { cache: "HIT" }]);
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      // Past the whole-run deadline in one render, so no time is left to verify.
      clock += 1_200;
      return fetcher.impl(url, init);
    }) as unknown as typeof fetch;

    const report = await runWarmup(
      [route({ path: "/about", tier: "cms", cacheClass: "isr" })],
      options({
        fetchImpl: impl,
        concurrency: 1,
        totalTimeoutMs: 1_000,
        monotonicNow: () => clock,
      }),
    );

    const result = report.results[0];
    expect(fetcher.calls).toHaveLength(1);
    expect(result.outcome).toBe("failed");
    expect(result.failure?.kind).toBe("not-attempted");
    expect(result.failure?.detail).toContain(
      "expired before the store on this address could be verified",
    );
    // The render is still credited, and the last real response is still reported.
    expect(result.rendered).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.cacheHeader).toBe("MISS");
    expect(result.cacheApplicable).toBe(true);
    expect(result.cacheVerified).toBe(false);
    // The whole point: the report attributes it to the deadline.
    expect(report.deadlineExpired).toBe(true);
  });
});

describe("nonceConsistencyProblem", () => {
  it("passes a document whose inline scripts carry the policy's nonce", () => {
    expect(nonceConsistencyProblem(POLICY, HTML)).toBeNull();
  });

  it("says nothing when the policy names no nonce", () => {
    expect(
      nonceConsistencyProblem(
        "default-src 'self'",
        "<html><script>x</script></html>",
      ),
    ).toBeNull();
  });

  it("catches an un-nonced inline script", () => {
    expect(
      nonceConsistencyProblem(
        POLICY,
        `<html><script>alert(1)</script><script nonce="abc123"></script></html>`,
      ),
    ).toContain("would not hydrate");
  });

  it("ignores a JSON-LD block and an external script", () => {
    expect(
      nonceConsistencyProblem(
        POLICY,
        `<html><script type="application/ld+json">{}</script><script src="/x.js"></script><script nonce="abc123"></script></html>`,
      ),
    ).toBeNull();
  });

  it("catches a stored document carrying a nonce the policy no longer names", () => {
    expect(
      nonceConsistencyProblem(
        "script-src 'nonce-NEW'",
        `<html><script nonce="OLD">x</script></html>`,
      ),
    ).toContain("every inline script on the page would be refused");
  });
});
