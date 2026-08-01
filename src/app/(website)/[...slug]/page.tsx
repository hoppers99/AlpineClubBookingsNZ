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

type DynamicPageProps = {
  params: Promise<{
    slug: string[];
  }>;
};

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
 * It is NOT a substitute for a segment-level guard. If the static/ISR slices in
 * #2352 land, or a `loading.tsx` is added here, the 404 decision has to move
 * somewhere that runs before the segment is rendered at all — this line will not
 * cover it.
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
 * still returned the page's own title and header text, so an anonymous prober —
 * who reaches this code by putting `Purpose: prefetch` on an ordinary request,
 * which skips the proxy matcher — could read an unlaunched club's whole page
 * inventory. Suppressing `{children}` in the layout does not help: the document
 * head is a separate flight slot from the page's seed data in next@16.2.11, so
 * metadata is produced even though the component never runs.
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
