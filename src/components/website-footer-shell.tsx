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
 *
 * ## The `(public)` group needs the same treatment (#2827 census)
 *
 * `PER_REQUEST_WEBSITE_ROUTES` lists the `(website-dynamic)` group only, and
 * that is correct for the questions IT answers — the setup gate, the CSP nonce,
 * the CMS catch-all's territory. It is the wrong boundary for THIS question.
 *
 * This footer is rendered by two layouts, `src/components/website/website-chrome.tsx`
 * for the website groups and `src/app/(public)/layout.tsx` for the `(public)`
 * group — and that second layout injects the club theme, admin Raw CSS included,
 * on exactly the same page. So every `(public)` route with a `[token]` segment was
 * stamping its bearer credential into `data-page-slug` for admin CSS to read,
 * through the very fix that closed the class next door.
 *
 * `/pay/[token]` is the one that matters most: it is the payment page, the token is
 * the payment bearer credential, and it is where the group-join flow #2827 was
 * filed about hands the visitor off to. Closing that flow's `<a href>` while the
 * destination page stamped the same token in an attribute would have moved the
 * oracle one hop rather than removed it. `/chores/[token]`,
 * `/family-invite/[token]` and `/membership-cancellation/[token]` are the same
 * shape and are closed here too.
 *
 * Query-string tokens (`/reset-password?token=…`, `/verify-email?token=…`) are NOT
 * affected: `usePathname()` returns the path without the query, so nothing from
 * the query reaches this attribute.
 *
 * That group has no equivalent published census to drive from, so its dynamic
 * routes are written down below — and `website-footer-shell-slug.test.tsx` reads
 * the `(public)` directory tree from disk and fails if a route there has a dynamic
 * segment this list does not cover. That disk scan is what stops the hand-written
 * half rotting in the dangerous direction, and it is the reason a second list is
 * acceptable here at all.
 */

/**
 * The `(public)` group's dynamic routes, which share this footer and the same
 * admin Raw CSS (#2827). Every one of them carries a one-time or bearer token in
 * its path.
 *
 * Exported as the seam `website-footer-shell-slug.test.tsx` compares against the
 * real `src/app/(public)` tree on disk, so adding a route there without adding it
 * here fails a test rather than silently reopening the oracle.
 */
export const PUBLIC_GROUP_DYNAMIC_ROUTES = [
  "/chores/[token]",
  "/family-invite/[token]",
  "/membership-cancellation/[token]",
  "/pay/[token]",
] as const;

/**
 * The census's dynamic routes, pre-split into segments, with `null` marking a
 * dynamic segment and the original pattern segment kept for the output.
 *
 * Static routes are dropped: they have no value to strip, and leaving them in
 * would make the loop below claim addresses it does not need to.
 */
const DYNAMIC_ROUTE_SHAPES = [
  ...PER_REQUEST_WEBSITE_ROUTES,
  ...PUBLIC_GROUP_DYNAMIC_ROUTES,
]
  .filter((route) => route.includes("["))
  .map((route) => ({
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
