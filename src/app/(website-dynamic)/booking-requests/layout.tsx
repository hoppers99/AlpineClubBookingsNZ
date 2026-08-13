import type { Metadata } from "next";

// The tokenised booking-request confirmation flows — `verify/[token]` and
// `respond/[token]` — carry one-time secure links and must never be indexed
// (#2421). A layout is the metadata seam because both pages are server wrappers
// around client components, and it keeps the whole tokenised sub-tree noindex in
// one place. The bare `/booking-requests` page is deliberately NOT covered here:
// it lives in the `(website)` group and is a listed, indexable public page.
//
// `public/robots.txt` must NOT disallow the prefix: a disallowed crawler never
// fetches the page, so it never sees this noindex, and could still list a bare
// token URL shared elsewhere. Allowing the crawl and answering with noindex is
// what actually keeps these links out of an index.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function BookingRequestsTokenLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
