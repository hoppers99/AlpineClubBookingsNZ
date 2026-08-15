import type { WebsiteNavLink } from "@/components/website-mobile-menu";

/**
 * The public header's navigation: `Home` always leads, and the CMS-driven menu
 * entries follow.
 *
 * The navigation is otherwise entirely the club's to arrange from the CMS — the
 * code owns no fixtures beyond Home. `Contact` is no exception: it appears only
 * when the `/contact` page carries a menu title, exactly like any other page.
 * (This removed the earlier code fallback that appended Contact unconditionally;
 * a club that wants Contact in its menu sets the page's menu title in the CMS.)
 *
 * The function is pure and unit-tested
 * (`src/lib/__tests__/website-nav.test.ts`) rather than reasoned about inside the
 * async header component.
 *
 * @param dynamicNavLinks the CMS-driven entries, already resolved to `{ href,
 *   label }` from `listWebsiteMenuPages()` (published rows carrying a menu title).
 */
export function buildWebsiteNavLinks(
  dynamicNavLinks: ReadonlyArray<WebsiteNavLink>,
): WebsiteNavLink[] {
  return [{ href: "/", label: "Home" }, ...dynamicNavLinks];
}
