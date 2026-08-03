import type { Metadata } from "next";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { setupInProgressMetadata } from "@/lib/website-setup-metadata";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import {
  getPublishedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";

/**
 * Held back from static rendering (#2352 slice 1, owner decision D4) — slice 3.
 * See `(website)/page.tsx` for why the line is required rather than tidy: with the
 * shared layout no longer reading the request, a fixed route without it is
 * prerendered at build, with no database and no CSP nonce.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  // Pre-setup, before any lookup (#2420 F1). See setupInProgressMetadata().
  // Post-setup, the published filter in the lookup below keeps a draft row out
  // of the head (#2440); the code-backed defaults take over.
  const holdingScreen = await setupInProgressMetadata();

  if (holdingScreen) {
    return holdingScreen;
  }

  const [page, { name: clubName }] = await Promise.all([
    getPublishedPageContentByPath("/join"),
    getCachedClubIdentity(),
  ]);
  return {
    title: page?.title ?? "Join the Club",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `How to become a member of the ${clubName}. Nomination by two existing members, joining fee, induction process, and membership details.`,
  };
}

export default async function JoinPage() {
  const [page, clubIdentity] = await Promise.all([
    getPublishedPageContentByPath("/join"),
    getCachedClubIdentity(),
  ]);
  const embeddedBody = page ? await buildEmbeddedBody(page.contentHtml) : [];
  const caption = page?.caption || "Join the Club";
  const title = page?.title || "Becoming a Member";
  const headerText =
    page?.headerText ||
    `How to become a member of the ${clubIdentity.name}. Nomination by two existing members, joining fee, induction process, and membership details.`;

  return (
    <>
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {title}
          </h1>
          <div
            className="mt-4 max-w-2xl text-lg text-brand-snow/80"
            dangerouslySetInnerHTML={{ __html: headerText }}
          />
        </div>
      </section>
      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {embeddedBody.length > 0 ? (
            <div className="space-y-10 text-base leading-7 text-brand-deep/85 [&_a]:text-brand-charcoal [&_a]:underline [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-4">
              <EmbeddedPageContentParts
                parts={embeddedBody}
                pageSlug="join"
                keyPrefix="join"
                clubIdentity={clubIdentity}
              />
            </div>
          ) : (
            <div className="rounded-lg border border-brand-ridge/35 bg-brand-mist/35 p-6 text-brand-deep/75">
              No content has been published for this page yet.
            </div>
          )}
        </div>
      </section>
    </>
  );
}
