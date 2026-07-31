import type { Metadata } from "next";

// The public booking-request form is deliberately UNLISTED (#2421): nothing on
// the public site links to it, and the club shares the direct URL only with
// guests it is willing to host. A layout is the metadata seam here because
// every page under this segment is a client component (`"use client"` cannot
// export `metadata`), and it covers the tokenised `verify/[token]` and
// `respond/[token]` pages in the same stroke — those carry secure links that
// must never be indexed either. `public/robots.txt` disallows the same prefix;
// this is the belt-and-braces half, for crawlers that reach the page from a
// shared link rather than from the site root.
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
