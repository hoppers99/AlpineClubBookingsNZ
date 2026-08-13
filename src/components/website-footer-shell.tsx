"use client";

import { usePathname } from "next/navigation";
import { PER_REQUEST_WEBSITE_ROUTES } from "@/lib/public-website-paths";

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
 *
 * ## Which is exactly why a dynamic segment's VALUE must never reach it (#2818
 * decision 8)
 *
 * Admin Raw CSS is admin-authored, but it is not a trusted read of the visitor's
 * URL, and an attribute selector can read one character at a time:
 *
 *     [data-page-slug^="booking-requests/verify/a"] { background: url(…/a); }
 *
 * Stamping the raw pathname put every one-time token in the product — the
 * booking-request verify and respond links, the school attendee confirmation
 * link, the group-join verification link — into a value CSS can exfiltrate
 * character by character. `/join/[code]` leaked a group code the same way. The
 * exposure predates this change on `/join/verify/[token]` and `/join/[code]`;
 * it is closed here for all of them at once rather than only for the routes
 * #2813 added.
 *
 * The fix is to emit the route SHAPE instead of the address:
 * `booking-requests/verify/[token]`, not `booking-requests/verify/9f3a…`. That
 * keeps the attribute doing its whole job — an admin styling "the verification
 * page" wants every visitor's verification page, never one visitor's — while
 * there is no longer a secret in it to select on.
 *
 * Matching is driven from {@link PER_REQUEST_WEBSITE_ROUTES}, the census that
 * already exists and that `check-website-render-modes.mjs` keeps equal to the
 * real route tree. A hand-written second list here would rot in the dangerous
 * direction: a token route added to the group and forgotten in the mirror would
 * silently start stamping its token again, with nothing failing.
 */

/**
 * The census's dynamic routes, pre-split into segments, with `null` marking a
 * dynamic segment and the original pattern segment kept for the output.
 *
 * Static routes are dropped: they have no value to strip, and leaving them in
 * would make the loop below claim addresses it does not need to.
 */
const DYNAMIC_ROUTE_SHAPES = PER_REQUEST_WEBSITE_ROUTES.filter((route) =>
  route.includes("["),
).map((route) => ({
  /** The value stamped when this shape matches, e.g. `join/verify/[token]`. */
  slug: route.replace(/^\//, ""),
  segments: route
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith("[") ? null : segment)),
}));

/**
 * The slug an admin's CSS may select on: the path with its leading slash
 * removed, and every dynamic segment replaced by its pattern.
 *
 * Segments are compared RAW, exactly as `src/lib/public-website-paths.ts`
 * compares them and exactly as Next matches routes, so a percent-encoded token
 * cannot slip past the shape match and be stamped verbatim.
 */
// test seam
export function pageSlugFromPathname(pathname: string | null): string {
  // Matches the slug the page sections use: "/" is "home", anything else is the
  // path without its leading slash ("/a/b" -> "a/b"). `null` is defended against
  // rather than assumed away: `usePathname()` is typed as a string but returns
  // null when no router context is mounted, and this component is also rendered
  // directly by unit tests.
  if (!pathname || pathname === "/") return "home";

  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  for (const shape of DYNAMIC_ROUTE_SHAPES) {
    if (shape.segments.length !== segments.length) continue;
    if (
      shape.segments.every(
        (expected, index) => expected === null || expected === segments[index],
      )
    ) {
      // The route's own pattern text, so the attribute reads
      // "booking-requests/verify/[token]" — recognisable to an admin writing CSS
      // and free of the visitor's secret.
      return shape.slug;
    }
  }

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
