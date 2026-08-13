import type { Metadata } from "next";
import { SchoolBookingForm } from "@/app/(website-dynamic)/school-bookings/school-booking-form";
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
 * The public school-group booking page: a database-backed built-in CMS page with
 * the same makeup as `/join/apply` and `/booking-requests` — a code-backed route
 * that renders its `/school-bookings` PageContent row through the token pipeline.
 * Its seeded body is `{{school-bookings}}`, which renders the school-group
 * request form.
 *
 * It sits in `(website-dynamic)` for the same reasons `/booking-requests` does;
 * that file's docblock carries the argument in full (#2818 decision 2). The short
 * version: D1's fixed-nonce census is an owner decision pinned at five, and this
 * is a page anonymous visitors type personal details into, so it keeps the
 * per-request nonce, no analytics, and no warm-up declaration.
 *
 * The tokenised attendee-confirmation flow — `confirm/[token]` — is a sibling
 * under this same directory; its URL is unchanged.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const holdingScreen = await setupInProgressMetadata();

  if (holdingScreen) {
    return holdingScreen;
  }

  const [page, { name: clubName }] = await Promise.all([
    getPublishedPageContentByPath("/school-bookings"),
    getCachedClubIdentity(),
  ]);

  return {
    title: page?.title ?? "School Bookings",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `Request a school group stay with ${clubName}.`,
  };
}

export default async function SchoolBookingsPage() {
  const [page, clubIdentity, lodgeCapacity] = await Promise.all([
    getPublishedPageContentByPath("/school-bookings"),
    getCachedClubIdentity(),
    getCachedDefaultLodgeCapacity(),
  ]);
  // DB-resolved default lodge capacity, spread over the identity so the form's
  // guest cap tracks the real lodge rather than the static fallback (#1982 R1).
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const embeddedBody = page ? await buildEmbeddedBody(page.contentHtml) : [];

  const caption = page?.caption ?? "For schools & groups";
  const title = page?.title ?? "School Bookings";
  const headerText =
    page?.headerText ||
    `Request a school group stay at ${liveClubIdentity.lodgeName}. We'll email you to confirm your address, then send a quote for your school to review.`;

  return (
    <>
      <section
        className="dynamic-header bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20"
        data-page-slug="school-bookings"
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
        data-page-slug="school-bookings"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {embeddedBody.length > 0 ? (
            <EmbeddedPageContentParts
              parts={embeddedBody}
              pageSlug="school-bookings"
              keyPrefix="school-bookings"
              clubIdentity={liveClubIdentity}
            />
          ) : (
            <SchoolBookingForm club={liveClubIdentity} />
          )}
        </div>
      </section>
    </>
  );
}
