import type { WebsiteNavLink } from "@/components/website-mobile-menu";

/**
 * The public header's navigation, built from the CMS-driven menu entries plus the
 * two links the code owns (#2818 decision 5).
 *
 * `Home` always leads. `Contact` is a FALLBACK, not a fixture: `/contact` is a
 * page every club has and expects in its menu, but the navigation is otherwise
 * entirely the club's to arrange, so the code appends a Contact link only when no
 * CMS entry already points at `/contact`. Deduping by href is the whole safety
 * property — a club that opts its Contact page into the menu (by giving the row a
 * menu title) shows the link exactly once, from its own entry, and this fallback
 * steps aside. It also fixes a latent duplicate on `main`, where a club that had
 * set the Contact page's menu title got the CMS link AND a then-unconditional
 * hard-coded one.
 *
 * There is no seeded label and no data migration behind Contact: this function is
 * the entire mechanism, which is why it is pure and unit-tested
 * (`src/lib/__tests__/website-nav.test.ts`) rather than reasoned about inside the
 * async header component.
 *
 * @param dynamicNavLinks the CMS-driven entries, already resolved to `{ href,
 *   label }` from `listWebsiteMenuPages()` (published rows carrying a menu title).
 */
export function buildWebsiteNavLinks(
  dynamicNavLinks: ReadonlyArray<WebsiteNavLink>,
): WebsiteNavLink[] {
  const navLinks: WebsiteNavLink[] = [
    { href: "/", label: "Home" },
    ...dynamicNavLinks,
  ];

  if (!navLinks.some((link) => link.href === "/contact")) {
    navLinks.push({ href: "/contact", label: "Contact" });
  }

  return navLinks;
}
