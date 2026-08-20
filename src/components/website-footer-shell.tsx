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
 * ## The `(public)` group is stamped by the same shape rule (#2827 census)
 *
 * `PER_REQUEST_WEBSITE_ROUTES` lists the `(website-dynamic)` group only, and
 * that is correct for the questions IT answers — the setup gate, the CSP nonce,
 * the CMS catch-all's territory. It is the wrong boundary for THIS question.
 *
 * This footer is rendered by two layouts: `src/components/website/website-chrome.tsx`
 * for the website groups, and `src/app/(public)/layout.tsx` for the `(public)`
 * group. Before #2827 every `(public)` route with a `[token]` segment fell through
 * to the raw-pathname branch, so `/pay/<payment token>` was stamped verbatim into
 * `data-page-slug`. `PUBLIC_GROUP_DYNAMIC_ROUTES` folds those routes into the
 * shapes, so the attribute now reads `pay/[token]`.
 *
 * **That change is defence in depth, and the first cut of #2827 recorded it as
 * something stronger — corrected 20 Aug 2026.** It claimed the `(public)` layout
 * injects admin Raw CSS on the same page, which would have made the stamped token
 * readable by an attribute selector. It does not: that layout injects
 * `theme.appCss`, built by `buildClubThemeAppCss()`, which **excludes** `rawCss` by
 * design. Only `buildClubThemeCss()` appends it, and that output reaches a page
 * document in three places — `website-chrome.tsx` (the `(website)` and
 * `(website-dynamic)` groups), the lodge display screen and the setup-in-progress
 * screen. So the oracle was live for the `(website-dynamic)` shapes above and was
 * **not** live for the `(public)` ones. What the `(public)` half buys is that the
 * attribute stops carrying a bearer credential at all, so moving that group under
 * the shared chrome — which is exactly what #2818 did to `(website-dynamic)` —
 * cannot reopen it silently. `/pay/[token]` is the one that would matter most: the
 * payment page's segment IS the payment bearer credential, and it is where the
 * group-join flow #2827 was filed about hands the visitor off to.
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
 * acceptable here at all. The scan recognises every extension Next's default
 * `pageExtensions` serves (`page.tsx`, `page.ts`, `page.jsx`, `page.js`), because a
 * `page.ts` route would otherwise have been invisible to it while being served
 * perfectly — the same class of hole `scripts/lib/file-size-budget.ts` documents
 * from a `git mv` that took a file out of a gate's scope.
 */

/**
 * The `(public)` group's dynamic routes, which share this footer (#2827). Every
 * one of them carries a one-time or bearer token in its path.
 *
 * Exported as the seam `website-footer-shell-slug.test.tsx` compares against the
 * real `src/app/(public)` tree on disk, so adding a route there without adding it
 * here fails a test rather than silently putting a token back in the attribute.
 */
export const PUBLIC_GROUP_DYNAMIC_ROUTES = [
  "/chores/[token]",
  "/family-invite/[token]",
  // #2780: the unauthenticated QR maintenance form. Added because #2827's guard
  // caught it -- this route was introduced in the same wave and stamped its raw
  // token into `data-page-slug`, which is precisely the class that guard exists
  // to stop coming back. It is the `(public)` group, so this is defence in depth
  // rather than a live oracle, for the reason set out above.
  "/lodge-maintenance/[token]",
  "/membership-cancellation/[token]",
  "/pay/[token]",
] as const;

/**
 * The static addresses a dynamic shape below would otherwise claim (review
 * finding, 20 Aug 2026).
 *
 * {@link DYNAMIC_ROUTE_SHAPES} matches on segment count plus literal segments and
 * knows nothing about which addresses a more specific STATIC route already owns.
 * `/join/apply` — the membership application form, a real page at
 * `src/app/(website)/join/apply/page.tsx` — is two segments beginning `join`, so it
 * matched `/join/[code]` and was stamped `join/[code]`. Two consequences, both
 * wrong and neither a leak: a club's `[data-page-slug="join/apply"]` rule silently
 * never applied, and a rule written for the group-join code page also restyled the
 * application form.
 *
 * Next resolves such an address to the static route, so the shape match must too —
 * the attribute's whole job is to name the route that actually rendered.
 *
 * Written by hand and then checked against the tree: `website-footer-shell-slug.test.tsx`
 * reads `(website)`, `(website-dynamic)` and `(public)` from disk, works out which
 * static routes a shape would claim, and requires equality with this list in both
 * directions. So adding `(public)/pay/help/page.tsx` fails a test rather than
 * quietly acquiring the `pay/[token]` slug.
 *
 * NOT covered, and it cannot be: a CMS page an admin creates under the
 * `(website)/[...slug]` catch-all at a colliding address (`/pay/help`) is not on
 * disk, so it would still be stamped with the shape. That mis-styles an admin's own
 * page and exposes nothing — the shape carries no visitor value either way — which
 * is why it is documented here rather than solved with a runtime lookup the footer
 * has no way to make.
 */
export const SHAPE_SHADOWED_STATIC_ROUTES = ["/join/apply"] as const;

const SHAPE_SHADOWED_ADDRESSES: ReadonlySet<string> = new Set(
  SHAPE_SHADOWED_STATIC_ROUTES,
);

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
  const address = `/${segments.join("/")}`;

  // A real static route wins over a shape of the same length, exactly as it does
  // in Next's route table — see SHAPE_SHADOWED_STATIC_ROUTES. Compared on the
  // rebuilt address so a trailing slash cannot slip past it.
  if (SHAPE_SHADOWED_ADDRESSES.has(address)) {
    return address.replace(/^\//, "");
  }

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
