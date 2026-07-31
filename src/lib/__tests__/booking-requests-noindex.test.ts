import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { metadata } from "@/app/(public)/booking-requests/layout";

// The guest booking-request form is deliberately UNLISTED (#2421): no page a
// visitor can browse to links to it, and the club hands the direct URL only to
// a guest it has agreed to host. The `/booking-requests` layout's `metadata`
// is the SOLE mechanism keeping that form — and its tokenised `verify/[token]`
// and `respond/[token]` sub-routes — out of search results, so it has a guard
// of its own here.
//
// `public/robots.txt` must NOT disallow the path, and that half is what someone
// is most likely to re-add as a "hardening" tidy-up. A disallowed crawler never
// fetches the page, so it never sees the noindex, and it can still list the
// bare URL it found in a shared link. Allowing the crawl and answering with
// noindex is what actually removes the page from an index.
describe("unlisted guest request form stays out of search engines (#2421)", () => {
  it("serves the whole /booking-requests segment noindex, nofollow", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("does not disallow the path in robots.txt, which would hide the noindex", () => {
    const robots = readFileSync(
      join(process.cwd(), "public", "robots.txt"),
      "utf8",
    );
    expect(robots).not.toContain("booking-requests");
  });
});
