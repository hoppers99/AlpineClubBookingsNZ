import Link from "next/link";
import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { getSanitizedPageContentByPath } from "@/lib/page-content-html";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";

/**
 * Must render per-request (issue #2356), for the same reason `/display` must
 * (`src/app/display/page.tsx`): the CSP is nonce-only in production and Next
 * stamps the nonce into its inline bootstrap/RSC scripts only during DYNAMIC
 * rendering, reading it from the request's own CSP header. Without this the
 * `/_not-found` route is prerendered at build time — Next then also copies it
 * to `pages/404.html`, which `base-server` serves for unmatched URLs — and that
 * artefact ships seven inline `<script>` tags with no `nonce`, every one of them
 * blocked by the very policy on the same response.
 *
 * It fixes two visible defects at the same time, both caused by the build-time
 * render having no database and no request:
 *  • `getSanitizedPageContentByPath("/404")` below failed at build and was
 *    swallowed by its `.catch(() => null)`, so the admin-authored `/404` CMS
 *    page could never appear — the hardcoded fallback was frozen into the HTML.
 *  • the root layout's `generateMetadata()` fell back to `SAFE_DEFAULT_CONFIG`,
 *    baking the template placeholder ("Example Mountain Club") and
 *    `http://localhost:3000` into every deployment's 404 title and OG tags.
 *
 * Cost is small: the app's `(website)/[...slug]` catch-all already claims almost
 * every mistyped or bot-probed URL and renders this boundary dynamically via
 * `notFound()`, so only the narrow set of paths that previously hit the static
 * artefact changes cost. `scripts/ci/check-prerendered-script-nonces.mjs` fails
 * the build if a prerendered route ever ships unnonced inline scripts again.
 */
export const dynamic = "force-dynamic";

function pageSlugFromPath(path: string) {
  return path.replace(/^\//, "") || "home";
}

export default async function NotFound() {
  const page = await getSanitizedPageContentByPath("/404").catch(() => null);

  if (page) {
    const headerHtml = { __html: page.headerText };
    const [embeddedBody, clubIdentity] = await Promise.all([
      buildEmbeddedBody(page.contentHtml),
      getCachedClubIdentity(),
    ]);
    const pageSlug = pageSlugFromPath(page.path);

    return (
      <>
        <section
          className="dynamic-header bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20"
          data-page-slug={pageSlug}
        >
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {page.caption && (
              <span className="website-eyebrow mb-4">{page.caption}</span>
            )}
            <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
              {page.title}
            </h1>
            {page.headerText && (
              <div
                className="mt-4 max-w-2xl text-lg text-brand-snow/80"
                dangerouslySetInnerHTML={headerHtml}
              />
            )}
          </div>
        </section>

        <section
          className="dynamic-body bg-brand-snow py-16 sm:py-20"
          data-page-slug={pageSlug}
        >
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {embeddedBody.length > 0 ? (
              <div className="text-base leading-7 text-brand-deep/85 [&_a]:text-brand-charcoal [&_a]:underline [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-4">
                <EmbeddedPageContentParts
                  parts={embeddedBody}
                  pageSlug={pageSlug}
                  keyPrefix="not-found"
                  clubIdentity={clubIdentity}
                />
              </div>
            ) : null}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-lg bg-brand-charcoal px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-brand-deep"
              >
                Go Home
              </Link>
              <Link
                href={buildBookingLoginPath()}
                className="inline-flex items-center justify-center rounded-lg border border-brand-ridge/40 px-6 py-3 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-mist"
              >
                Book a Stay
              </Link>
            </div>
          </div>
        </section>
      </>
    );
  }

  // Fallback when the /404 page content record doesn't exist yet.
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="mx-auto max-w-md px-4 text-center">
        <h1 className="mb-4 text-6xl font-bold text-gray-900">404</h1>
        <h2 className="mb-4 text-2xl font-semibold text-gray-700">
          Page Not Found
        </h2>
        <p className="mb-8 text-gray-500">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg bg-gray-900 px-6 py-3 text-white transition-colors hover:bg-gray-800"
          >
            Go Home
          </Link>
          <Link
            href={buildBookingLoginPath()}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-3 text-gray-700 transition-colors hover:bg-gray-100"
          >
            Book a Stay
          </Link>
        </div>
      </div>
    </div>
  );
}
