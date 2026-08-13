import type { Metadata } from "next";
import { BookingRequestForm } from "@/app/(website-dynamic)/booking-requests/booking-request-form";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import {
  getCachedClubIdentity,
  getCachedDefaultLodgeCapacity,
} from "@/lib/public-layout-config";
import { setupInProgressMetadata } from "@/lib/website-setup-metadata";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import {
  getPublishedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";

/**
 * The public booking-request page: a database-backed built-in CMS page with the
 * same makeup as `/join/apply` — a code-backed route that renders its
 * `/booking-requests` PageContent row through the token pipeline. Its seeded body
 * is `{{booking-requests}}`, which renders the request-to-book form.
 *
 * ## Why it sits in `(website-dynamic)` rather than `(website)` (#2818 decision 2)
 *
 * Everything about the page says fixed-nonce group: it is CMS-backed, its content
 * is twice-sanitised admin HTML, and it sits beside `/contact` and `/join/apply`
 * in the admin's Page Content list. It is here anyway for two reasons. D1's
 * fixed-nonce census is an owner decision pinned at five addresses, and widening
 * it is a decision about the CSP rather than a routing detail. And this is one of
 * the two pages where an anonymous visitor types the most personal information,
 * so the unguessable per-request nonce is worth more here than a stored copy of a
 * form that is `force-dynamic` regardless.
 *
 * The consequences of that placement are all deliberate: no Google Analytics
 * (decision 3), no warm-up declaration (decision 4), and the pre-setup holding
 * screen in front of it exactly as before.
 *
 * `force-dynamic` is declared here as well as on the group layout, because each
 * route in this group is per-request for a permanent reason of its own and the
 * reason belongs next to the route (`check-website-render-modes.mjs` requires
 * both).
 *
 * The two tokenised confirmation flows — `respond/[token]` and `verify/[token]` —
 * are siblings under this same directory; their URLs are unchanged.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  // Pre-setup, before any lookup (#2420 F1). See setupInProgressMetadata().
  const holdingScreen = await setupInProgressMetadata();

  if (holdingScreen) {
    return holdingScreen;
  }

  const [page, { name: clubName }] = await Promise.all([
    getPublishedPageContentByPath("/booking-requests"),
    getCachedClubIdentity(),
  ]);

  return {
    title: page?.title ?? "Booking Requests",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `Request a stay with ${clubName} without creating an account.`,
  };
}

export default async function BookingRequestsPage() {
  const [page, clubIdentity, lodgeCapacity] = await Promise.all([
    getPublishedPageContentByPath("/booking-requests"),
    getCachedClubIdentity(),
    getCachedDefaultLodgeCapacity(),
  ]);
  // DB-resolved default lodge capacity, spread over the identity so the form's
  // guest cap tracks the real lodge rather than the static fallback (#1982 R1).
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const embeddedBody = page ? await buildEmbeddedBody(page.contentHtml) : [];

  const caption = page?.caption ?? "Request a stay";
  const title = page?.title ?? "Booking Requests";
  const headerText =
    page?.headerText ||
    `Request a stay at ${liveClubIdentity.lodgeName} without creating an account. We'll email you to confirm your address, then review and price your request.`;

  return (
    <>
      <section
        className="dynamic-header bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20"
        data-page-slug="booking-requests"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {title}
          </h1>
          {/* headerText is sanitised on read by the page-content helper. */}
          <div
            className="mt-4 max-w-2xl text-lg text-brand-snow/80"
            dangerouslySetInnerHTML={{ __html: headerText }}
          />
        </div>
      </section>

      <section
        className="dynamic-body bg-brand-snow py-16 sm:py-20"
        data-page-slug="booking-requests"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {embeddedBody.length > 0 ? (
            <EmbeddedPageContentParts
              parts={embeddedBody}
              pageSlug="booking-requests"
              keyPrefix="booking-requests"
              clubIdentity={liveClubIdentity}
            />
          ) : (
            <BookingRequestForm club={liveClubIdentity} />
          )}
        </div>
      </section>
    </>
  );
}
