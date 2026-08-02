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

function scriptSrcNonce(response: APIResponse): string {
  const policy = response.headers()["content-security-policy"];
  expect(policy, "every response must carry a CSP").toBeTruthy();

  const scriptSrc = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("script-src "));
  expect(scriptSrc, "the policy must carry a script-src").toBeTruthy();

  const nonce = (scriptSrc as string).match(/'nonce-([^']+)'/)?.[1];
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

  expect(website.headers()["content-security-policy"]).not.toContain(
    "https://js.stripe.com",
  );
  expect(login.headers()["content-security-policy"]).toContain(
    "https://js.stripe.com",
  );
  // Neither may reach for the blunt option the owner rejected.
  expect(website.headers()["content-security-policy"]).not.toContain(
    "'unsafe-inline'; ",
  );
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
