import type { Metadata } from "next";

// The public booking-request form is deliberately UNLISTED (#2421): no page a
// visitor can browse to links to it, and the club shares the direct URL only
// with guests it is willing to host. The one other way in is the "Book these
// dates again" button on a tokenised `/pay/[token]` page — a link the club
// itself emails to an already-vetted requester, so it reaches nobody new.
//
// This metadata is the sole and correct mechanism for keeping the form out of
// search results, and `public/robots.txt` deliberately does NOT disallow the
// prefix: a disallowed crawler never fetches the page, so it never sees this
// noindex, and it can still list the bare URL from a shared link found
// elsewhere. Allowing the crawl and answering with noindex is what actually
// removes it. A layout is the metadata seam here because every page under this
// segment is a client component (`"use client"` cannot export `metadata`), and
// it covers the tokenised `verify/[token]` and `respond/[token]` pages in the
// same stroke — those carry secure links that must never be indexed either.
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
