"use client";

import { usePathname } from "next/navigation";

/**
 * The public footer's outer element, so `data-page-slug` can come from the URL
 * instead of a request header (#2352).
 *
 * `(website)/layout.tsx` used to read the slug from the `x-page-slug` header the
 * proxy set. That was a `headers()` call, and `headers()` in a layout is one of the
 * two lines that forced every public page to be rendered from scratch on every
 * visit. `usePathname()` gives the same answer without reading the request: it is
 * not a dynamic API, so it resolves to the real path during static generation and
 * to the live path in the browser.
 *
 * The attribute is kept rather than dropped because an admin's custom CSS can
 * target it — the same per-page hook the page sections expose (see the CSS help
 * text in `src/components/admin/page-content-panel.tsx`).
 */
function pageSlugFromPathname(pathname: string | null): string {
  // Matches the slug the page sections use: "/" is "home", anything else is the
  // path without its leading slash ("/a/b" -> "a/b"). `null` is defended against
  // rather than assumed away: `usePathname()` is typed as a string but returns
  // null when no router context is mounted, and this component is also rendered
  // directly by unit tests.
  if (!pathname || pathname === "/") return "home";
  return pathname.replace(/^\//, "") || "home";
}

export function WebsiteFooterShell({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <footer className={className} data-page-slug={pageSlugFromPathname(pathname)}>
      {children}
    </footer>
  );
}
