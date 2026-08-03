"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WebsiteLogo } from "@/components/website-logo";
import { useSignedInHint } from "@/hooks/use-signed-in-hint";
import type { WebsiteHeaderCtaVariants } from "@/lib/website-header-ctas";

export interface WebsiteNavLink {
  href: string;
  label: string;
}

interface WebsiteMobileMenuProps extends WebsiteHeaderCtaVariants {
  clubName: string;
  logoUrl?: string | null;
  logoDataUrl?: string | null;
  navLinks: ReadonlyArray<WebsiteNavLink>;
}

export function WebsiteMobileMenu({
  clubName,
  logoUrl,
  logoDataUrl,
  navLinks,
  anonymous,
  member,
}: WebsiteMobileMenuProps) {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  // #2352 D2: the drawer takes the same two CTA variants the desktop header does
  // and reads the same marker cookie, so the two can never disagree about who the
  // visitor is — or, since #2430, about what the Book Now button is called.
  // Configurable public Book Now (E3 #1929): `bookNow` is null when the admin has
  // hidden it, which is an admin choice and therefore identical in both variants.
  const signedIn = useSignedInHint();
  const variant = signedIn ? member : anonymous;

  const isActiveLink = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href;

  const closeMenu = useCallback(() => {
    if (detailsRef.current) {
      detailsRef.current.open = false;
    }
  }, []);

  useEffect(() => {
    closeMenu();
  }, [closeMenu, pathname]);

  return (
    <details ref={detailsRef} className="group relative lg:hidden">
      <summary
        aria-label="Open menu"
        className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md text-brand-snow transition-colors hover:bg-brand-snow/10 hover:text-brand-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold [&::-webkit-details-marker]:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </summary>
      <div className="website-mobile-menu absolute right-0 top-12 w-72 rounded-md border border-brand-ridge/25 bg-brand-charcoal p-5 text-brand-snow shadow-2xl">
        <div className="mb-5">
          <WebsiteLogo
            label={clubName}
            logoUrl={logoUrl}
            logoDataUrl={logoDataUrl}
            className="max-h-8 max-w-36"
            textClassName="text-brand-snow"
          />
        </div>
        <nav
          aria-label="Website menu"
          className="flex max-h-72 flex-col gap-1 overflow-y-auto"
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={closeMenu}
              aria-current={isActiveLink(link.href) ? "page" : undefined}
              className="rounded-md px-3 py-2.5 text-sm font-medium text-brand-snow/85 transition-colors hover:bg-brand-snow/10 hover:text-brand-snow aria-[current=page]:bg-brand-snow/15 aria-[current=page]:font-semibold aria-[current=page]:text-brand-snow"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="mt-6 flex flex-col gap-2 border-t border-brand-snow/10 px-3 pt-6">
          <Button
            variant="outline"
            size="sm"
            asChild
            className="w-full border-brand-snow/20 bg-brand-snow/5 text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
          >
            <Link href={variant.account.href} onClick={closeMenu}>
              {variant.account.label}
            </Link>
          </Button>
          {variant.bookNow ? (
            <Button
              size="sm"
              asChild
              className="w-full shadow-lg shadow-brand-gold/20"
            >
              <Link href={variant.bookNow.href} onClick={closeMenu}>
                {variant.bookNow.label}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
