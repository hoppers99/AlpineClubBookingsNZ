import Link from "next/link";
import { WebsiteLogo } from "@/components/website-logo";
import { CLUB_NAME } from "@/config/club-identity";
import { getSiteFooterContent } from "@/lib/site-content";

// Styles the admin-editable footer HTML (sanitised on write and read) so the
// starter content renders identically to the previously hardcoded markup:
// h3 headings, link lists, and the blurb paragraph keep the same classes the
// static footer used.
const FOOTER_HTML_CLASSES =
  "[&_h3]:mb-3 [&_h3]:font-heading [&_h3]:text-lg [&_h3]:font-semibold " +
  "[&_h3]:text-brand-snow [&_ul]:text-sm [&_ul>li+li]:mt-2 [&_p]:text-sm " +
  "[&_p]:leading-relaxed [&_a]:transition-colors [&_a:hover]:text-brand-gold";

// Tailwind needs literal class names, so map the computed column count.
const GRID_COLUMNS_CLASS: Record<number, string> = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
};

export async function WebsiteFooter({
  logoDataUrl,
  pageSlug,
}: {
  logoDataUrl?: string | null;
  pageSlug: string;
}) {
  const { blurbHtml, quickLinksHtml, affiliationsHtml } =
    await getSiteFooterContent();

  // The club-info column always renders because it carries the code-managed
  // logo block; an empty blurb only removes its paragraph. The link columns
  // disappear entirely when an admin saves them empty.
  const columnCount =
    1 + (quickLinksHtml ? 1 : 0) + (affiliationsHtml ? 1 : 0);

  return (
    <footer
      className="border-t border-brand-gold/15 bg-brand-charcoal text-brand-snow/90"
      data-page-slug={pageSlug}
    >
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div
          className={`grid grid-cols-1 gap-8 ${GRID_COLUMNS_CLASS[columnCount]}`}
        >
          {/* Club info (logo is code-rendered; blurb is admin-editable) */}
          <div>
            <div className="mb-3">
              <WebsiteLogo
                label={CLUB_NAME}
                logoDataUrl={logoDataUrl}
                className="max-h-10 max-w-40 brightness-110"
                textClassName="text-brand-snow"
              />
            </div>
            {blurbHtml ? (
              <div
                className={FOOTER_HTML_CLASSES}
                dangerouslySetInnerHTML={{ __html: blurbHtml }}
              />
            ) : null}
          </div>

          {/* Quick links (admin-editable) */}
          {quickLinksHtml ? (
            <div
              className={FOOTER_HTML_CLASSES}
              dangerouslySetInnerHTML={{ __html: quickLinksHtml }}
            />
          ) : null}

          {/* Affiliations (admin-editable) */}
          {affiliationsHtml ? (
            <div
              className={FOOTER_HTML_CLASSES}
              dangerouslySetInnerHTML={{ __html: affiliationsHtml }}
            />
          ) : null}
        </div>

        {/* Legal row stays code-rendered: auto year, non-removable links. */}
        <div className="mt-10 border-t border-brand-ridge/30 pt-6 text-center text-sm text-brand-snow/85">
          <p>
            &copy; {new Date().getFullYear()} {CLUB_NAME} Incorporated. All
            rights reserved.
          </p>
          <p className="mt-2 space-x-4">
            <Link
              href="/privacy"
              className="transition-colors hover:text-brand-gold"
            >
              Privacy Policy
            </Link>
            <span aria-hidden="true">&middot;</span>
            <Link
              href="/terms"
              className="transition-colors hover:text-brand-gold"
            >
              Terms of Service
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
