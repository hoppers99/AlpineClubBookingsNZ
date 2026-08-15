import { describe, expect, it } from "vitest";
import { buildWebsiteNavLinks } from "@/lib/website-nav";

/**
 * The header nav builder's contract: Home leads and the CMS entries follow,
 * verbatim and in order. The code owns no fixtures beyond Home — Contact
 * included, it appears only when the CMS provides it.
 */
describe("buildWebsiteNavLinks", () => {
  it("always leads with Home", () => {
    expect(buildWebsiteNavLinks([])[0]).toEqual({ href: "/", label: "Home" });
  });

  it("appends the CMS entries after Home, in order", () => {
    const links = buildWebsiteNavLinks([
      { href: "/about", label: "About" },
      { href: "/contact", label: "Kōrero mai" },
    ]);

    expect(links).toEqual([
      { href: "/", label: "Home" },
      { href: "/about", label: "About" },
      { href: "/contact", label: "Kōrero mai" },
    ]);
  });

  it("does not synthesise a Contact link when the CMS omits one", () => {
    // Contact is no longer a code fallback: a club that has not given its
    // /contact page a menu title gets no Contact entry in the nav.
    const links = buildWebsiteNavLinks([{ href: "/about", label: "About" }]);

    expect(links.some((link) => link.href === "/contact")).toBe(false);
    expect(links).toEqual([
      { href: "/", label: "Home" },
      { href: "/about", label: "About" },
    ]);
  });
});
