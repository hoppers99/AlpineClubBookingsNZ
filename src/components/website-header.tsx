import Link from "next/link";
import { WebsiteLogo } from "@/components/website-logo";
import { WebsiteNavLinks } from "@/components/website-nav-links";
import { WebsiteHeaderCtas } from "@/components/website-header-ctas";
import {
  WebsiteMobileMenu,
  type WebsiteNavLink,
} from "@/components/website-mobile-menu";
import { getBookNowVariants } from "@/lib/book-now-config";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { listWebsiteMenuPages } from "@/lib/page-content-html";
import { buildWebsiteNavLinks } from "@/lib/website-nav";
import type { WebsiteHeaderCtaVariants } from "@/lib/website-header-ctas";

interface WebsiteHeaderProps {
  logoUrl?: string | null;
  logoDataUrl?: string | null;
}

/**
 * The public site header.
 *
 * Takes NO session (#2352 D2). It used to receive an `isAuthenticated` boolean
 * from `(website)/layout.tsx`, and that layout's `auth()` call was one of the two
 * lines that forced every public page to be rendered from scratch on every visit.
 * It is rendered by the shared chrome now
 * (`src/components/website/website-chrome.tsx`), which reads neither.
 * The header now renders BOTH forms of its call-to-action pair and lets the
 * browser pick from the non-secret marker cookie — see
 * `src/lib/signed-in-hint.ts` for what that cookie is and is not.
 *
 * Everything else here is club configuration rather than visitor state, so it
 * stays on the server and is stored with the page.
 */
export async function WebsiteHeader({
  logoUrl,
  logoDataUrl,
}: WebsiteHeaderProps) {
  const [dynamicPages, clubIdentity, bookNow] = await Promise.all([
    listWebsiteMenuPages(),
    getCachedClubIdentity(),
    getBookNowVariants(),
  ]);
  const clubName = clubIdentity.name;
  const dynamicNavLinks = dynamicPages.map((page) => ({
    href: page.path,
    label: page.menuTitle.trim(),
  }));
  // Home, the CMS-driven entries, then a Contact fallback appended only when no
  // CMS entry already links there — deduped by href so a club that opts its
  // Contact page into the menu shows it exactly once (#2818 decision 5). See
  // `buildWebsiteNavLinks`.
  const navLinks: WebsiteNavLink[] = buildWebsiteNavLinks(dynamicNavLinks);
  // Configurable public Book Now (E3 #1929): hidden, custom page, or the default
  // booking flow (fail-open). The authenticated dashboard CTA is out of scope.
  // #2430: the LABEL is resolved there too, from the SESSION rather than the
  // target — a signed-out visitor cannot book from this button whichever target
  // is configured, so it names its audience rather than promising a walk-in
  // booking. Since #2352 both labels are resolved together and the browser picks.
  const ctaVariants: WebsiteHeaderCtaVariants = {
    anonymous: {
      account: { href: "/login", label: "Log In" },
      bookNow: bookNow.show ? bookNow.anonymous : null,
    },
    member: {
      account: { href: "/dashboard", label: "Dashboard" },
      bookNow: bookNow.show ? bookNow.member : null,
    },
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-brand-gold/15 bg-brand-charcoal/95 text-brand-snow shadow-[0_16px_40px_-28px_rgba(47,47,43,0.9)] backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Branding */}
        <Link
          href="/"
          className="flex items-center gap-2 font-bold text-brand-snow transition-opacity hover:opacity-85"
        >
          <WebsiteLogo
            label={clubName}
            logoUrl={logoUrl}
            logoDataUrl={logoDataUrl}
            className="max-h-10 max-w-40"
            textClassName="max-w-48 text-brand-snow"
          />
        </Link>

        {/* Desktop nav links */}
        <WebsiteNavLinks navLinks={navLinks} />

        {/* Desktop CTAs — picked in the browser (#2352 D2) */}
        <WebsiteHeaderCtas {...ctaVariants} />

        <WebsiteMobileMenu
          clubName={clubName}
          logoUrl={logoUrl}
          logoDataUrl={logoDataUrl}
          navLinks={navLinks}
          {...ctaVariants}
        />
      </div>
    </header>
  );
}
