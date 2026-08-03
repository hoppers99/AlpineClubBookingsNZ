import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "../prisma/e2e-fixtures";

/**
 * The admin-authored CMS pages served from full-route ISR (#2352 slice 1).
 *
 * Everything here needs a REAL server, and each case says why the unit suite
 * cannot stand in for it:
 *
 *  • the fixed per-release nonce is only meaningful if the nonce in the POLICY on a
 *    later response still matches the nonce FROZEN into the stored HTML — two
 *    different things that only a real render puts side by side;
 *  • the prefetch case (F1, the reconciliation's highest-severity finding) is about
 *    what a prefetch-shaped request causes to be STORED, which needs a store;
 *  • unpublish → 404 (F4) is simultaneously the verification the reconciliation
 *    asked for on `revalidatePublicSite()`: if `revalidatePath("/", "layout")` did
 *    not clear full-route ISR entries, an unpublished page would keep answering 200
 *    from the store and this spec would fail. Nothing short of a real cache can
 *    show that.
 *
 * This stack is seeded `SEED_THEME_COMPLETE=1` (.github/workflows/e2e.yml) and
 * built with `RELEASE_ID=<commit sha>`, so the site is open and the nonce is
 * genuinely release-derived rather than the per-process fallback.
 *
 * Anonymous on purpose except where a case says otherwise: a stored page is one
 * copy served to everyone, and the anonymous visitor is who it is stored for.
 */

/** A seeded CMS page served by the `(website)/[...slug]` catch-all. */
const CMS_PAGE = "/about";

/**
 * One named directive out of the response's policy.
 *
 * Assertions here MUST go through this rather than matching against the whole
 * header, and the slice-1 review is why: the D1 tightening drops Stripe from
 * `script-src` ONLY, and `https://js.stripe.com` is still legitimately present in
 * `connect-src` and `frame-src`. A whole-header `not.toContain` therefore fails on
 * a correct policy — and, worse, would not have caught Stripe coming BACK into
 * `script-src`, which is the property the test claims to hold. The same trap
 * applies to `'unsafe-inline'`, which `style-src` carries on every route.
 */
function directive(response: APIResponse, name: string): string {
  const policy = response.headers()["content-security-policy"];
  expect(policy, "every response must carry a CSP").toBeTruthy();

  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  expect(found, `the policy must carry a ${name}`).toBeTruthy();

  return found as string;
}

function scriptSrcNonce(response: APIResponse): string {
  const nonce = directive(response, "script-src").match(/'nonce-([^']+)'/)?.[1];
  expect(nonce, "script-src must name a nonce").toBeTruthy();
  return nonce as string;
}

/** Every inline `<script>` open tag in `html` that carries no non-empty nonce. */
function unnoncedInlineScripts(html: string): string[] {
  const offenders: string[] = [];

  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (/\btype\s*=\s*["']?application\/(?:ld\+)?json/i.test(attributes)) continue;
    if (/\bnonce\s*=\s*(?:"[^"]+"|'[^']+'|[^\s"'>]+)/i.test(attributes)) continue;
    offenders.push(match[0]);
  }

  return offenders;
}

test("a CMS page is served with the SAME script nonce on every request", async ({
  request,
}) => {
  const first = await request.get(CMS_PAGE);
  const second = await request.get(CMS_PAGE);

  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);

  const nonce = scriptSrcNonce(first);
  expect(
    scriptSrcNonce(second),
    "a stored page can carry only one nonce, so the policy must not change between responses",
  ).toBe(nonce);
});

test("every inline script in the stored page carries the nonce the policy names", async ({
  request,
}) => {
  // The "zero CSP violations" half of the measurement gate, asserted rather than
  // eyeballed in a console. A mismatch here is a page that never hydrates.
  const response = await request.get(CMS_PAGE);
  const html = await response.text();
  const nonce = scriptSrcNonce(response);

  expect(unnoncedInlineScripts(html)).toEqual([]);
  expect(
    html.includes(`nonce="${nonce}"`),
    "the nonce stamped into the HTML must be the one the policy allows",
  ).toBe(true);
});

/**
 * F1 (#2352 reconciliation, highest severity).
 *
 * `Purpose: prefetch` and `Next-Router-Prefetch` are ordinary request headers
 * anyone can set. The proxy matcher used to skip them, which under full-route ISR
 * would mean a prefetch-shaped miss GENERATING and STORING a page with no nonce
 * stamped in — and that copy then being served to every later visitor under the
 * nonce-only policy, so nothing on the page would execute. #2404 removed the
 * exemption; this is the assertion that keeps it removed, on the wire.
 */
for (const [label, headers] of [
  ["Purpose: prefetch", { Purpose: "prefetch" }],
  ["Next-Router-Prefetch", { "Next-Router-Prefetch": "1" }],
  ["Sec-Purpose: prefetch", { "Sec-Purpose": "prefetch" }],
] as const) {
  test(`a ${label} request stores a fully nonced page`, async ({ request }) => {
    const prefetched = await request.get(`${CMS_PAGE}?prefetch-probe=${Date.now()}`, {
      headers,
    });

    expect(prefetched.status(), `${label} must reach the app, not be skipped`).toBe(
      200,
    );

    const nonce = scriptSrcNonce(prefetched);
    const html = await prefetched.text();

    expect(
      unnoncedInlineScripts(html),
      "a prefetch-shaped request must not produce a nonce-less page",
    ).toEqual([]);
    expect(html.includes(`nonce="${nonce}"`)).toBe(true);

    // And an ordinary request for the same address gets the same nonce, so a
    // page stored by a prefetch is still usable by everyone else.
    const ordinary = await request.get(CMS_PAGE);
    expect(scriptSrcNonce(ordinary)).toBe(nonce);
  });
}

test("Stripe is dropped from script-src on the public website and kept elsewhere", async ({
  request,
}) => {
  // The tightening bundled with D1's trade. `/login` is a `(public)` route, so it
  // keeps a per-request nonce and the unchanged policy.
  const website = await request.get(CMS_PAGE);
  const login = await request.get("/login");

  expect(directive(website, "script-src")).not.toContain("https://js.stripe.com");
  expect(directive(login, "script-src")).toContain("https://js.stripe.com");
  // Stripe stays where it was never the point: the payment surfaces reach
  // api.stripe.com and frame js.stripe.com, and D1 did not touch either.
  expect(directive(website, "connect-src")).toContain("https://api.stripe.com");
  expect(directive(website, "frame-src")).toContain("https://js.stripe.com");
  // Google Tag Manager stays in script-src — the analytics module loads gtag from
  // it on exactly these pages.
  expect(directive(website, "script-src")).toContain(
    "https://www.googletagmanager.com",
  );
  // And the public website may not reach for the blunt option the owner rejected.
  expect(directive(website, "script-src")).not.toContain("'unsafe-inline'");
});

test("a stored CMS page is never offered to a shared cache", async ({ request }) => {
  // The #2322 invariant, asserted where slice 1 moved it (slice-1 review).
  // `export const revalidate = 300` makes Next fill in
  // `s-maxage=300, stale-while-revalidate=31535700` of its own accord
  // (`server/lib/cache-control.js` + the 31536000 `expireTime` default), which is
  // precisely the directive #2322 exists to keep off public pages: a shared cache
  // would store the page and could then serve it stale for the best part of a
  // year, where `revalidatePublicSite()` cannot reach it. The unit suite asserts
  // the proxy's own header; only a real server shows which header survives to the
  // wire, because the framework writes its own when the proxy has not.
  const response = await request.get(CMS_PAGE);
  const cacheControl = response.headers()["cache-control"] ?? "";

  expect(cacheControl, "a CMS page must carry a Cache-Control").toBeTruthy();
  expect(cacheControl).toContain("private");
  expect(cacheControl).not.toContain("s-maxage");
  expect(cacheControl).not.toContain("stale-while-revalidate");
});

test("an anonymous visitor gets the signed-out header on a stored page", async ({
  page,
}) => {
  await page.goto(CMS_PAGE);

  await expect(page.getByRole("link", { name: "Log In" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
});

test("a stored page loads in a browser with no CSP or hydration complaint", async ({
  page,
}) => {
  // The "zero CSP violations in the console" half of the #2352 measurement gate,
  // asserted in a real browser rather than eyeballed — and the same run covers
  // hydration, because both replacements for the layout's request reads could fail
  // here and nowhere else:
  //  • a blocked inline script means the fixed nonce and the stored HTML disagree,
  //    and the page never becomes interactive;
  //  • a hydration mismatch would mean a client component rendered one thing during
  //    generation and another in the browser — the footer's `data-page-slug`, which
  //    now comes from `usePathname()` instead of a request header, is the one to
  //    watch.
  // Filtered to those two classes on purpose: a broad "no console errors" assertion
  // would fail on unrelated noise and get deleted rather than fixed.
  const complaints: string[] = [];
  const WATCHED = [
    "content security policy",
    "refused to execute",
    "refused to load",
    "hydration",
    "hydrating",
  ];

  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    if (WATCHED.some((needle) => text.toLowerCase().includes(needle))) {
      complaints.push(text);
    }
  });

  await page.goto(CMS_PAGE);
  // The CTA is rendered by a client component reading the marker cookie, so it
  // being visible means React has hydrated and any mismatch has been reported.
  await expect(page.getByRole("link", { name: "Log In" }).first()).toBeVisible();

  expect(complaints).toEqual([]);
  // And the footer's slug came out as the real address, not the "home" fallback
  // `usePathname()` returns with no router context.
  await expect(page.locator("footer[data-page-slug]")).toHaveAttribute(
    "data-page-slug",
    CMS_PAGE.replace(/^\//, ""),
  );
});

test.describe("signed in", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

  test("the header corrects itself in the browser from the marker cookie", async ({
    page,
  }) => {
    // #2352 D2. The page itself is the same stored copy the anonymous visitor
    // above was served — the server no longer knows who is asking — so this only
    // passes if the marker cookie and the client-side swap both work.
    await page.goto(CMS_PAGE);

    await expect(page.getByRole("link", { name: "Dashboard" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Log In" })).toHaveCount(0);

    const hint = (await page.context().cookies()).find(
      (cookie) => cookie.name === "signed-in-hint",
    );
    expect(hint?.value).toBe("1");
    // A display hint, not a session: readable by the page, and carrying one bit.
    expect(hint?.httpOnly).toBe(false);
  });
});

test.describe("a slug under another route group's prefix", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

  /**
   * F1 (slice-1 review). `(website)/[...slug]` claims every URL no other route
   * claims, which is WIDER than the set the proxy gives the fixed per-release nonce
   * to — so a page served in the difference would be STORED carrying a per-request
   * nonce that no later response names, and every inline script on it would be
   * refused. `/pay` is the live shape: `pay` was reserved nowhere, and `(public)/pay`
   * holds only `[token]/`, so the bare path fell through to the catch-all.
   */
  test("is refused at the write, and the address is a plain 404", async ({
    request,
  }) => {
    const created = await request.post("/api/admin/page-content", {
      data: {
        slug: "pay",
        caption: "How to pay",
        menuTitle: "",
        title: "How to pay",
        headerText: "",
        sortOrder: 9100,
      },
    });

    expect(
      created.status(),
      "a slug under another route group's prefix must be refused at the write",
    ).toBe(400);
    expect(((await created.json()) as { error: string }).error).toContain(
      "reserved",
    );

    // And the address itself answers a plain miss rather than a page nobody can use.
    expect((await request.get("/pay")).status()).toBe(404);
  });
});

/**
 * The D1 narrowing (owner decision, 3 Aug 2026): the fixed per-release nonce covers
 * exactly the five approved routes, and the three public pages the first cut swept
 * in are back on a freshly minted per-request nonce.
 *
 * Only a real server can show this. The unit suite proves the PROXY publishes two
 * different nonces for the two territories; what has to hold is that each RENDER
 * stamps the value its own response's policy names — the proxy's header and Next's
 * stamping are separate mechanisms, and a mismatch means every inline script on the
 * page is refused and the page never becomes interactive.
 */
test.describe("the per-request public pages (#2352 D1 narrowing)", () => {
  /**
   * `/hut-leader-instructions` with no `?a=`: PIN-gated and per-assignment, so it is
   * `force-dynamic` for a permanent reason and shows a form rather than any
   * assignment. That is enough for every assertion here, all of which are about the
   * nonce and the shared chrome rather than the page's own content.
   */
  const PER_REQUEST_PAGE = "/hut-leader-instructions";

  test("gets a FRESH nonce on every request, and the HTML matches its own", async ({
    request,
  }) => {
    const first = await request.get(PER_REQUEST_PAGE);
    const second = await request.get(PER_REQUEST_PAGE);

    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);

    const firstNonce = scriptSrcNonce(first);
    const secondNonce = scriptSrcNonce(second);

    expect(
      secondNonce,
      "a page that is never stored must mint a nonce per response — that unguessable " +
        "value is the defence the five approved routes give up, and this page gives " +
        "up nothing",
    ).not.toBe(firstNonce);

    // Each response's own HTML carries its own value, and no inline script is left
    // unnonced. Both halves matter: equal-but-absent would also pass a looser check.
    for (const [response, nonce] of [
      [first, firstNonce],
      [second, secondNonce],
    ] as const) {
      const html = await response.text();
      expect(unnoncedInlineScripts(html)).toEqual([]);
      expect(
        html.includes(`nonce="${nonce}"`),
        "the nonce stamped into the HTML must be the one this response's policy allows",
      ).toBe(true);
    }
  });

  test("is not served the release nonce that a stored CMS page carries", async ({
    request,
  }) => {
    // The narrowing from both sides in one case. `/about` is stored and carries the
    // release value; this page must not, or the move would be cosmetic.
    const stored = await request.get(CMS_PAGE);
    const perRequest = await request.get(PER_REQUEST_PAGE);

    expect(scriptSrcNonce(perRequest)).not.toBe(scriptSrcNonce(stored));
  });

  test("still gets the tightened public-website policy", async ({ request }) => {
    // The deliberate asymmetry: the Stripe tightening follows the WIDE predicate, so
    // narrowing the NONCE must not have handed this page a looser policy as a side
    // effect. Stripe.js is loaded only from the member payment surfaces.
    const response = await request.get(PER_REQUEST_PAGE);

    expect(directive(response, "script-src")).not.toContain("https://js.stripe.com");
    expect(directive(response, "script-src")).not.toContain("'unsafe-inline'");
  });

  test("loads in a browser with no CSP or hydration complaint", async ({ page }) => {
    // The property the split exists to protect, in the only place it can fail: a
    // per-request nonce that the render did not receive would block every inline
    // script here and the page would never hydrate. Watched classes only — a broad
    // "no console errors" assertion fails on unrelated noise and gets deleted rather
    // than fixed.
    const complaints: string[] = [];
    const WATCHED = [
      "content security policy",
      "refused to execute",
      "refused to load",
      "hydration",
      "hydrating",
    ];

    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      const text = message.text();
      if (WATCHED.some((needle) => text.toLowerCase().includes(needle))) {
        complaints.push(text);
      }
    });

    await page.goto(PER_REQUEST_PAGE);
    // Rendered by the shared chrome's client component reading the marker cookie, so
    // it being visible means React hydrated and any mismatch has been reported.
    await expect(page.getByRole("link", { name: "Log In" }).first()).toBeVisible();

    expect(complaints).toEqual([]);
    // And the chrome really is the SAME chrome: the footer's slug comes from
    // `usePathname()` in the shared component, so a per-group copy would show here.
    await expect(page.locator("footer[data-page-slug]")).toHaveAttribute(
      "data-page-slug",
      PER_REQUEST_PAGE.replace(/^\//, ""),
    );
  });
});

/**
 * The #2570 residual, pinned at the properties that must hold rather than at the
 * fault — and with the fault's SEVERITY corrected by measurement.
 *
 * A mistyped member-area address is claimed by the CMS catch-all, which refuses it
 * (it is outside the fixed-nonce set) and raises a 404 — and that 404 DOCUMENT is
 * stored, so a later visitor is served a copy whose baked-in nonce the new policy no
 * longer names and whose inline scripts are therefore refused. Measured on a
 * container build of this branch: two requests for `/admin/typo` both answered 404,
 * the second with a fresh policy nonce while the HTML still carried the first
 * request's value.
 *
 * **The severity is worse than the briefing that produced the decision said, and the
 * measurement is why.** A `notFound()` response from this route has ZERO
 * server-rendered visible markup: `<body>` is an empty placeholder and the whole 404
 * screen arrives inside the RSC flight payload, which is carried in nonce'd inline
 * `<script>` tags (measured: 0 visible characters outside `<script>` on
 * `/admin/typo`, `/dashboard/nope` AND the in-territory `/definitely-missing`, versus
 * ~3.7k on `/contact`). So the refused-script outcome is a BLANK page, not the
 * readable-but-inert page the owner was told about. The in-territory miss is
 * unaffected because it carries the fixed nonce and the policy keeps naming it.
 *
 * The owner chose to stop storing those documents (option 2, 3 Aug). Next's
 * per-render cache opt-out answers 500 on next@16.2.12, and a proxy rewrite cannot
 * substitute for it because middleware runs before routing and cannot tell a typo
 * from a real member address. So the decision is back with the owner, and these cases
 * assert only what is TRUE and must stay true: a proper 404 on both requests (no
 * 500 — the outcome option 2's own terms said to drop the change for), the club's own
 * 404 content present in the document, and a per-request nonce rather than the
 * release value. The mismatch itself is deliberately NOT asserted: a test that pins a
 * fault fails the day the fault is fixed.
 */
test.describe("a mistyped member-area address", () => {
  for (const address of ["/dashboard/nope", "/admin/typo"]) {
    test(`answers a proper 404 twice in a row at ${address}`, async ({ request }) => {
      const first = await request.get(address);
      const second = await request.get(address);

      expect(first.status(), "a mistyped address must never 500").toBe(404);
      expect(second.status(), "including when served from the store").toBe(404);

      // The club's own 404 screen, not Next's built-in one: `src/app/not-found.tsx`
      // renders the admin-authored `/404` page content, or its hardcoded fallback.
      expect(await second.text()).toContain("Page Not Found");

      // A per-request nonce, not the release value — these addresses belong to
      // another route group and the narrowing did not change that.
      expect(scriptSrcNonce(second)).not.toBe(
        scriptSrcNonce(await request.get(CMS_PAGE)),
      );
    });
  }
});

/**
 * F4, and the verification of `revalidatePublicSite()` the reconciliation asked
 * for (#2352 F3).
 *
 * Hiding a page has to take effect at once. If `revalidatePath("/", "layout")` did
 * not clear the full-route store, the unpublished page would keep answering 200
 * from it for up to the 300-second backstop — so a passing assertion here IS the
 * evidence that the call clears stored pages and not merely the tagged data caches.
 */
test.describe("unpublishing a CMS page", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

  /**
   * The probe page this case hides, created rather than borrowed.
   *
   * It cannot be one of the seeded pages: `canUnpublishPage()`
   * (`src/lib/page-content.ts`) refuses to hide a system or built-in slug —
   * `about`, `join`, `rules`, `contact`, `committee`, `privacy`, `terms`, `faq` —
   * because code routes, the footer and the sitemap link them, so the admin PATCH
   * answers 422 for every one of them. An admin-CREATED page is the only kind the
   * product allows hiding, which is also the case an operator actually meets.
   *
   * `menuTitle` is empty on purpose: `listWebsiteMenuPages()` drops a page with no
   * menu title, so the probe never appears in the public navigation and no other
   * spec's expectations move. It is left hidden at the end for the same reason.
   */
  const PROBE_SLUG = "e2e-isr-unpublish-probe";
  const PROBE_PATH = `/${PROBE_SLUG}`;

  async function probePageId(request: APIRequestContext): Promise<string> {
    const created = await request.post("/api/admin/page-content", {
      data: {
        slug: PROBE_SLUG,
        caption: "ISR probe",
        menuTitle: "",
        title: "ISR probe",
        headerText: "",
        sortOrder: 9000,
      },
    });

    if (created.status() === 201) {
      return ((await created.json()) as { page: { id: string } }).page.id;
    }

    // 409: a previous run left it behind (there is no delete endpoint). Reuse it.
    expect(
      created.status(),
      "the probe page must be creatable or already present",
    ).toBe(409);

    const listed = await request.get("/api/admin/page-content");
    expect(listed.status()).toBe(200);
    const { pages } = (await listed.json()) as {
      pages: Array<{ id: string; path: string }>;
    };
    const existing = pages.find((candidate) => candidate.path === PROBE_PATH);
    expect(existing, `${PROBE_PATH} must exist after a 409`).toBeTruthy();
    return existing!.id;
  }

  async function setPublished(
    request: APIRequestContext,
    id: string,
    published: boolean,
  ) {
    const response = await request.patch("/api/admin/page-content", {
      data: { id, published },
    });
    expect(response.status()).toBe(200);
  }

  test("clears the stored page immediately, and republishing restores it", async ({
    request,
  }) => {
    const id = await probePageId(request);

    try {
      // Published on create (`PageContent.published` defaults true), so this both
      // warms the store and shows on-demand generation working for an address
      // that did not exist when the release was built — the whole point of
      // `generateStaticParams()` returning an empty list.
      await setPublished(request, id, true);
      expect((await request.get(PROBE_PATH)).status()).toBe(200);

      await setPublished(request, id, false);
      expect(
        (await request.get(PROBE_PATH)).status(),
        "a hidden page must 404 at once — a 200 here means the stored copy outlived the write",
      ).toBe(404);

      await setPublished(request, id, true);
      expect(
        (await request.get(PROBE_PATH)).status(),
        "republishing must restore it just as immediately",
      ).toBe(200);
    } finally {
      // Leave the site as this spec found it.
      await setPublished(request, id, false);
    }
  });
});
