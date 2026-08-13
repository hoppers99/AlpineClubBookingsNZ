import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { metadata as tokenLayoutMetadata } from "@/app/(website-dynamic)/booking-requests/layout";
import { metadata as respondMetadata } from "@/app/(website-dynamic)/booking-requests/respond/[token]/page";
import { metadata as verifyMetadata } from "@/app/(website-dynamic)/booking-requests/verify/[token]/page";

// The bare `/booking-requests` page is now a listed, indexable public website
// page (owner decision: advertise the booking-request form). Its tokenised
// confirmation flows — `verify/[token]` and `respond/[token]` — still carry
// one-time secure links and must NEVER be indexed (#2421). They live under
// `(website-dynamic)/booking-requests/`, whose layout carries the noindex, and
// each token route restates it.
//
// `public/robots.txt` must NOT disallow the path, and that half is what someone
// is most likely to re-add as a "hardening" tidy-up. A disallowed crawler never
// fetches the page, so it never sees the noindex, and it can still list a bare
// token URL found in a shared link. Allowing the crawl and answering with
// noindex is what actually removes a token page from an index.
describe("tokenised booking-request links stay out of search engines (#2421)", () => {
  it("serves the tokenised confirmation sub-tree noindex, nofollow", () => {
    expect(tokenLayoutMetadata.robots).toEqual({ index: false, follow: false });
    expect(respondMetadata.robots).toEqual({ index: false, follow: false });
    expect(verifyMetadata.robots).toEqual({ index: false, follow: false });
  });

  it("does not disallow the path in robots.txt, which would hide the noindex", () => {
    const robots = readFileSync(
      join(process.cwd(), "public", "robots.txt"),
      "utf8",
    );
    expect(robots).not.toContain("booking-requests");
  });
});
