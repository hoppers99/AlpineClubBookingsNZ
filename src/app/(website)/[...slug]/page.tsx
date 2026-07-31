import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import {
  getSanitizedPageContentByPath,
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
// `getSanitizedPageContentByPath()` carries no request memo of its own, so the
// row was fetched twice. #2405 assumed that lookup was "already cached per
// request"; it was not — what was covering for it is Prisma's automatic
// `findUnique` batching, which folds same-tick reads of the same key into one
// `WHERE path IN (...)` statement. That is a coincidence of timing, not a
// guarantee: it only holds while both calls land in the same tick. This makes
// it explicit. Keyed on the resolved slug string rather than the props object,
// because Next hands `generateMetadata` and the component separate `params`
// promises, so a per-object memo would never hit.
const loadPublishedPage = cache(async (slug: string) => {
  if (!isValidPageSlug(slug) || isReservedPageSlug(slug)) {
    return null;
  }

  const page = await getSanitizedPageContentByPath(`/${slug}`);
  // Unpublished (hidden) admin pages 404 for the public, just like a missing
  // page; only an explicit false hides it, so legacy rows stay visible.
  if (!page || page.published === false) {
    return null;
  }
  return page;
});

async function getPageForParams(props: DynamicPageProps) {
  const params = await props.params;
  return loadPublishedPage(params.slug.join("/"));
}

function pageSlugFromPath(path: string) {
  return path.replace(/^\//, "") || "home";
}

/**
 * Raises the miss here, before the page component renders (#2405, owner
 * decision 31 Jul 2026 "Option A").
 *
 * Be clear about what this does and does not buy, because the issue's
 * hypothesis turned out to be wrong. It was thought the response shell flushed
 * before this route's database read resolved, committing a 200 that the later
 * `notFound()` could no longer change. It does not: measured on a club that has
 * completed site-style setup, every unmatched shape in the issue
 * (`/definitely-missing`, `/wp-admin/setup-config.php`, `/.env`, `/admin/nope`,
 * `/foo%00bar`, `POST /definitely-missing`) ALREADY answered 404 before this
 * line existed. `notFound()` from a page is caught by Next's
 * `HTTPAccessFallbackBoundary` and the status is set from the render, not from
 * a race with the wire.
 *
 * So this is a guard, not a repair, and it is kept for one reason: it is the
 * only version of the decision that survives the page being rendered behind a
 * streaming boundary. Today nothing in `(website)` has a `loading.tsx`, so the
 * page sits in the shell and its own `notFound()` below is reached in time.
 * Add one — or take the static/ISR slices in #2352 — and the component's throw
 * could land after the shell is committed, which is exactly the failure the
 * issue described. Deciding in `generateMetadata()` runs earlier than any of
 * that.
 *
 * `loadPublishedPage()` memoises the lookup for the request, so the component's
 * own `getPageForParams()` call below reuses this result rather than repeating
 * the query.
 */
export async function generateMetadata(
  props: DynamicPageProps,
): Promise<Metadata> {
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
          {/* headerText is returned by getSanitizedPageContentByPath. */}
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
