import { describe, expect, it } from "vitest";
import { buildWebsiteNavLinks } from "@/lib/website-nav";

/**
 * The header nav builder's contract (#2818 decision 5): Home leads, the CMS
 * entries follow, and Contact is a code fallback that fires exactly when no CMS
 * entry already links to `/contact`.
 */
describe("buildWebsiteNavLinks", () => {
  it("always leads with Home", () => {
    expect(buildWebsiteNavLinks([])[0]).toEqual({ href: "/", label: "Home" });
  });

  it("appends a Contact fallback when no entry links to /contact", () => {
    const links = buildWebsiteNavLinks([{ href: "/about", label: "About" }]);

    expect(links).toEqual([
      { href: "/", label: "Home" },
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
    ]);
  });

  it("does not append the fallback when a CMS entry already links to /contact", () => {
    const links = buildWebsiteNavLinks([
      { href: "/about", label: "About" },
      { href: "/contact", label: "Kōrero mai" },
    ]);

    const contact = links.filter((link) => link.href === "/contact");
    expect(contact).toHaveLength(1);
    // The club's own entry is kept untouched; the fallback did not run.
    expect(contact[0]).toEqual({ href: "/contact", label: "Kōrero mai" });
  });

  it("keeps the club's Contact link in the position the club chose", () => {
    // The dedupe must not move the entry to the end — a club that ordered its
    // Contact link first keeps it first.
    const links = buildWebsiteNavLinks([
      { href: "/contact", label: "Contact" },
      { href: "/about", label: "About" },
    ]);

    expect(links.map((link) => link.href)).toEqual(["/", "/contact", "/about"]);
  });
});
