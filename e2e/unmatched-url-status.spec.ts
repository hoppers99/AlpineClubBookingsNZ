import { expect, test } from "@playwright/test";

// The status LINE for URLs nothing serves (#2405). The unit suite
// (src/app/__tests__/unmatched-url-status.test.ts) pins that the route code
// raises notFound(); only a real server can show what status that puts on the
// wire, which is the thing the issue was actually about — a soft 404 tells
// search engines a dead address is real content and tells monitoring that a
// missing page is a working one.
//
// Anonymous on purpose: these are the shapes a crawler or a vulnerability
// scanner asks for, so no login is used.
//
// This stack is seeded with SEED_THEME_COMPLETE=1 (.github/workflows/e2e.yml),
// so it renders the real public site. That matters here: without it
// (website)/layout.tsx serves its "Site setup in progress" holding screen
// INSTEAD of the page, the page's notFound() never runs, and every URL below
// would answer 200. Measuring a stack that lacked the flag is how #2405 came to
// report a soft 404 that a configured club does not have.

const unmatchedPageUrls = [
  "/definitely-missing",
  "/wp-admin/setup-config.php",
  "/.env",
  "/admin/nope",
];

test("unmatched website URLs answer 404, and still show the page-not-found screen", async ({
  page,
}) => {
  for (const url of unmatchedPageUrls) {
    const response = await page.goto(url);
    expect(response?.status(), `${url} must not be a soft 404`).toBe(404);
  }

  // Status and body together: a 404 that stopped showing the club's own
  // "page not found" content would pass a status-only assertion. This heading
  // comes from the seeded /404 CMS page rendered per-request (#2356).
  await expect(
    page.getByRole("heading", { name: "Page Not Found" }),
  ).toBeVisible();
});

test("a real published page is still 200 — the fix must not 404 live content", async ({
  page,
}) => {
  const response = await page.goto("/about");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "About" }).first()).toBeVisible();
});

test("unmatched /api URLs answer 404 as JSON, never the website's HTML page", async ({
  request,
}) => {
  // Before #2405 these fell through to the (website) CMS catch-all and a JSON
  // client was handed ~23KB of text/html.
  for (const url of ["/api/definitely-missing", "/api/admin/nope"]) {
    const response = await request.get(url);

    expect(response.status(), `${url} must be a hard 404`).toBe(404);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
  }

  // A POST must not be answered any differently from a GET.
  const posted = await request.post("/api/definitely-missing");
  expect(posted.status()).toBe(404);
  expect(await posted.json()).toEqual({ error: "Not found" });
});

test("a real API route is untouched by the catch-all", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
});
