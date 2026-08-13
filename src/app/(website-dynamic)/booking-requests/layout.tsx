import type { Metadata } from "next";

// The DEFAULT for everything under `/booking-requests`, and it is deliberately
// the closed one.
//
// The tokenised confirmation flows — `verify/[token]` and `respond/[token]` —
// carry one-time secure links and must NEVER be indexed (#2421). Declaring that
// here keeps the whole sub-tree covered, including any route added later, and
// each token page restates it for itself.
//
// The BARE `/booking-requests` page is covered too, and that is the right
// default rather than an oversight (#2818 decision 1): advertising the form is
// opt-in per club, so a deployment that has not set a menu title stays out of
// search. That page's own `generateMetadata()` states its `robots` value in both
// directions and overrides this one when the club has opted in — page metadata
// wins over layout metadata field by field.
//
// `public/robots.txt` must NOT disallow the prefix: a disallowed crawler never
// fetches the page, so it never sees this noindex, and could still list a bare
// token URL shared elsewhere. Allowing the crawl and answering with noindex is
// what actually keeps these links out of an index.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function BookingRequestsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
