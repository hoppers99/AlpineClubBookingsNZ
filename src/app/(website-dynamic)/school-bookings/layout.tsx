import type { Metadata } from "next";

// The DEFAULT for everything under `/school-bookings`, deliberately the closed
// one — see `(website-dynamic)/booking-requests/layout.tsx`, which carries the
// full reasoning.
//
// The tokenised attendee-confirmation flow — `confirm/[token]` — carries a
// one-time secure link and must never be indexed (#2421). The bare
// `/school-bookings` page inherits the noindex until a club opts in by setting a
// menu title, at which point that page's own `generateMetadata()` overrides it
// (#2818 decision 1).
//
// `public/robots.txt` must NOT disallow the prefix: a disallowed crawler never
// fetches the page, so it never sees this noindex, and could still list a bare
// token URL shared elsewhere.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SchoolBookingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
