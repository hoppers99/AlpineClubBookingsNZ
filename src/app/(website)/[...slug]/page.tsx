import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { setupInProgressMetadata } from "@/lib/website-setup-metadata";
import {
  getPublishedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";
import { isReservedPageSlug, isValidPageSlug } from "@/lib/page-content";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import { isCmsServablePageSlug } from "@/lib/public-website-paths";

type DynamicPageProps = {
  params: Promise<{
    slug: string[];
  }>;
};

/**
 * The admin-authored CMS pages are served from FULL-ROUTE ISR (#2352 slice 1,
 * owner decision D4): rendered once on the first request for a path, stored, and
 * handed out to every later visitor until the content changes.
 *
 * ## Returning `[]` is deliberate and load-bearing
 *
 * There is no database during `docker build` (`Dockerfile` points `DATABASE_URL`
 * at an unreachable host so the build cannot depend on one), so the page list
 * cannot be enumerated at build time. `[]` plus the default `dynamicParams: true`
 * means: prerender NOTHING at build, generate each path on its first real request,
 * then store it.
 *
 * That also happens to be what makes this slice safe to ship first (#2352
 * reconciliation, F2). `scripts/ci/check-prerendered-script-nonces.mjs` fails any
 * route that emits build-time HTML, because a build-time render has no request and
 * therefore no CSP nonce, and the nonce-only policy then blocks every inline
 * script on it. This route emits no build-time HTML at all, so the guard stays
 * green — and a later change that started prerendering paths here would trip it
 * rather than ship a page that never hydrates. `[...slug]/__tests__` asserts this
 * still returns an empty list.
 *
 * ## Why a stored copy is not a leak
 *
 * Nothing in this render or in `(website)/layout.tsx` reads the session, the
 * cookies or the headers — that is the whole of slice 1 — so there is no
 * per-visitor content to freeze. The public header's one signed-in boolean is
 * resolved in the browser from a non-secret marker cookie (D2). Any component that
 * DID call `auth()`/`cookies()`/`headers()` would opt this route out of static
 * rendering automatically, so the failure mode of getting that wrong is a silent
 * performance regression, not a disclosure.
 */
export function generateStaticParams(): { slug: string[] }[] {
  return [];
}

/**
 * The freshness backstop (#2352 D3, owner decision 31 Jul 2026): 300 seconds.
 *
 * An admin EDIT still appears immediately — `revalidatePublicSite()` fires on every
 * page-content write and clears this route's stored entries outright. Since the
 * slice-1 review that also covers the writes that change what the page BODY renders
 * server-side: lodge capacity (`{{lodge-capacity}}`) and the images tree
 * (`{{photo-gallery}}`), which used to clear a tag the stored page did not carry, or
 * nothing at all.
 *
 * **This number is NOT a bound on how stale a visitor's page can be, and calling it
 * one was wrong.** Read against the vendored next@16.2.12:
 * `IncrementalCache.get()` marks an entry stale once `revalidateAfter` has passed,
 * and `ResponseCache.handleGet()` then RESOLVES THAT STALE ENTRY to the requester
 * before starting the background regeneration
 * (`response-cache/index.js` — `resolve(previousIncrementalCacheEntry)` runs first).
 * So a change with no write behind it — a site banner whose start time simply
 * arrives — is still absent for the first visitor after the window lapses, and
 * appears from the request after that one. On a quiet weekend that second request
 * can be hours later, so the observed staleness is unbounded in wall-clock terms
 * rather than capped at five minutes. A Link prefetch is worse again: with
 * `isPrefetch` set, revalidation is skipped entirely, so it is served stale and does
 * not even trip the rebuild.
 *
 * What IS bounded is the admin path, and by a different mechanism: only a TAG
 * EXPIRY (what `revalidatePath` produces) makes the cache return null and force a
 * blocking regeneration. That is why an edit is genuinely instant and why the
 * Playwright unpublish case can assert a 404 on the very next request.
 *
 * The owner chose 300 over 60 so a busy site does not pay a background re-render
 * every minute; the previous behaviour was ~15 seconds (the tagged config caches).
 */
export const revalidate = 300;

// Resolves the catch-all segments to a PageContent path. Static routes
// always win over this catch-all, so code-backed pages are unaffected.
// Reserved names are rejected in every segment position so database pages
// can never sit underneath application route prefixes.
//
// Wrapped in React `cache()` so the one lookup is shared by `generateMetadata()`
// and the page component within a single request (#2405). Both call it and
// `getPublishedPageContentByPath()` carries no request memo of its own, so the
// row was fetched twice. #2405 assumed that lookup was "already cached per
// request"; it was not — what was covering for it is Prisma's automatic
// `findUnique` batching, which folds same-tick reads of the same key into one
// `WHERE path IN (...)` statement. That is a coincidence of timing, not a
// guarantee: it only holds while both calls land in the same tick. This makes
// it explicit. Keyed on the resolved slug string rather than the props object,
// because Next hands `generateMetadata` and the component separate `params`
// promises, so a per-object memo would never hit.
//
// Unpublished (hidden) admin pages 404 for the public, just like a missing
// page — the published filter lives in the shared helper (#2440) so every
// public route hides drafts the same way.
const loadPublishedPage = cache(async (slug: string) => {
  if (!isValidPageSlug(slug) || isReservedPageSlug(slug)) {
    return null;
  }

  // The nonce boundary, and it has to be checked HERE as well as on the admin
  // write (#2352 slice-1 review, F1).
  //
  // This route is the one that fills the full-route store, and it claims every
  // URL no other route claims — a strictly WIDER set than the addresses the proxy
  // gives the fixed per-release nonce to (`isFixedNonceWebsitePath()`: the five
  // approved `(website)` routes and nothing else). A page served in the difference
  // is rendered with whatever per-request nonce its generating request carried,
  // stored with that value frozen into its inline scripts, and then handed to
  // every later visitor under a policy naming a different one: nothing on the
  // page executes and it never hydrates.
  //
  // `pay` was the live example — a legal slug (`RESERVED_PAGE_SLUGS` held only
  // nine names), a root segment in `NON_WEBSITE_ROOT_SEGMENTS`, and no bare
  // `(public)/pay` route to claim it, so `/pay` reached this catch-all. So do
  // every deeper form under a member-area segment (`/calendar/2026`,
  // `/notices/summer`, `/profile/help`).
  //
  // `isReservedPageSlug()` now refuses these at the admin write, so a new page
  // cannot be created here at all; this guard is what covers a row created
  // before that rule existed. 404 rather than serve it: a plain miss is a better
  // answer than a page whose every script the browser refuses, and the admin is
  // told why at save time.
  if (!isCmsServablePageSlug(slug)) {
    return null;
  }

  return getPublishedPageContentByPath(`/${slug}`);
});

async function getPageForParams(props: DynamicPageProps) {
  const params = await props.params;
  return loadPublishedPage(params.slug.join("/"));
}

function pageSlugFromPath(path: string) {
  return path.replace(/^\//, "") || "home";
}

/**
 * Raises the miss here as well as in the component below (#2405, owner
 * decision 31 Jul 2026 "Option A").
 *
 * Be clear about what this does and does not buy, because both the issue's
 * hypothesis AND this guard's first justification turned out to be wrong.
 *
 * The issue supposed the response shell flushed before this route's database
 * read resolved, committing a 200 that the later `notFound()` could no longer
 * change. It does not: measured on a club that has completed site-style setup,
 * every unmatched shape in the issue (`/definitely-missing`,
 * `/wp-admin/setup-config.php`, `/.env`, `/admin/nope`, `/foo%00bar`,
 * `POST /definitely-missing`) ALREADY answered 404 before this line existed.
 * `notFound()` from a page is caught by Next's `HTTPAccessFallbackBoundary` and
 * the status is set from the render, not from a race with the wire.
 *
 * This guard was then justified as "the version of the decision that survives a
 * streaming boundary". That is false, and saying so is the point of this
 * paragraph — read against the vendored next@16.2.11 rather than assumed.
 * `create-component-tree.js` puts `MetadataOutlet` in the SAME `Fragment` as the
 * page element (both children of one `createSeedData` call), so a `loading.tsx`
 * added to this segment would wrap the two of them together, not one ahead of
 * the other. Worse for the claim: when metadata is STREAMED — which is the
 * default for anything not in `HTML_LIMITED_BOT_UA_RE`, and Googlebot is not in
 * it — `metadata.js`'s `MetadataOutlet` puts its pending promise behind an
 * EXTRA `Suspense`, so it commits the status LATER than the page's own
 * `notFound()`, not earlier. Do not describe this as running "before the page
 * renders": the two render concurrently.
 *
 * What it does buy, honestly:
 *  • for an HTML-limited bot (`serveStreamingMetadata` false — the crawlers in
 *    that list) Next blocks on metadata instead of streaming it, so the miss is
 *    settled without the page tree having to produce anything; and
 *  • on a configured club the metadata branch below is never reached for a URL
 *    with no page, so a miss cannot emit a `<title>` describing a page that
 *    does not exist.
 *
 * It is NOT a substitute for a segment-level guard, and #2352 slice 1 answered the
 * question that used to be left open here rather than moving the decision. The
 * decision STAYS in this render, and what makes that safe is enforcement rather
 * than hope: `scripts/ci/check-website-render-modes.mjs` fails the build if a
 * `loading.tsx`, `template.tsx`, `default.tsx` or a Partial Prerendering flag ever
 * appears under `(website)`, which is the only way a boundary could commit a 200
 * ahead of this decision. Full-route ISR does not change it — Next stores the
 * `notFound()` outcome as a 404 cache entry, so a miss answers 404 on the request
 * that GENERATES it and on every request served from the store afterwards, and the
 * Playwright unpublish case asserts both.
 *
 * `loadPublishedPage()` memoises the lookup for the request, so the component's
 * own `getPageForParams()` call below reuses this result rather than repeating
 * the query.
 *
 * Pre-setup, NOTHING about this page is disclosed — not the miss, and not the
 * hit either. `setupInProgressMetadata()` runs FIRST and short-circuits both
 * paths (#2420 review finding F1).
 *
 * The earlier version of this guard consulted the setup state only inside
 * `if (!page)`. That was the enumeration oracle it was written to prevent,
 * merely inverted: pre-setup a miss returned the bare club name while a HIT
 * still returned the page's own title and header text, so an anonymous prober
 * who reached this code could read an unlaunched club's whole page inventory.
 * The route in at the time was a crafted `Purpose: prefetch` header, which the
 * proxy matcher skipped; #2404 removed that exemption altogether. What still
 * reaches this code pre-setup is an asset-extension URL the setup gate refuses
 * to claim (deliberately — the holding screen is a document) and that no `/api`
 * route matches, `/API/x.png` being the live shape. Suppressing `{children}` in
 * the layout does not help: the document head is a separate flight slot from the
 * page's seed data in next@16.2.11, so metadata is produced even though the
 * component never runs.
 *
 * `notFound()` is therefore unreachable pre-setup, which is still the right
 * answer for the reason it always was: the root not-found boundary sits ABOVE
 * `(website)/layout.tsx`, so a 404 raised here escapes the holding screen and
 * would serve database-backed 404 content from a site that has not opened.
 */
export async function generateMetadata(
  props: DynamicPageProps,
): Promise<Metadata> {
  const holdingScreen = await setupInProgressMetadata();

  if (holdingScreen) {
    return holdingScreen;
  }

  const [page, { name: clubName }] = await Promise.all([
    getPageForParams(props),
    getCachedClubIdentity(),
  ]);

  if (!page) {
    notFound();
  }

  return {
    title: page.title,
    description:
      pageContentHtmlToPlainText(page.headerText) ||
      `${page.title} information for ${clubName}.`,
  };
}

export default async function DynamicWebsitePage(props: DynamicPageProps) {
  const [page, clubIdentity] = await Promise.all([
    getPageForParams(props),
    getCachedClubIdentity(),
  ]);

  if (!page) {
    notFound();
  }

  const embeddedBody = await buildEmbeddedBody(page.contentHtml);
  const headerHtml = { __html: page.headerText };
  const pageSlug = pageSlugFromPath(page.path);

  return (
    <>
      <section
        className="dynamic-header bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20"
        data-page-slug={pageSlug}
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{page.caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {page.title}
          </h1>
          {/* headerText is sanitised on read by the page-content helper. */}
          <div
            className="mt-4 max-w-2xl text-lg text-brand-snow/80"
            dangerouslySetInnerHTML={headerHtml}
          />
        </div>
      </section>
      <section
        className="dynamic-body bg-brand-snow py-16 sm:py-20"
        data-page-slug={pageSlug}
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {embeddedBody.length > 0 ? (
            <div className="space-y-10 text-base leading-7 text-brand-deep/85 [&_a]:text-brand-charcoal [&_a]:underline [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-4">
              <EmbeddedPageContentParts
                parts={embeddedBody}
                pageSlug={pageSlug}
                clubIdentity={clubIdentity}
              />
            </div>
          ) : (
            <div
              className="dynamic-empty rounded-lg border border-brand-ridge/35 bg-brand-mist/35 p-6 text-brand-deep/75"
              data-page-slug={pageSlug}
            >
              No content has been published for this page yet.
            </div>
          )}
        </div>
      </section>
    </>
  );
}
