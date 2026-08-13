import type { Metadata } from "next";

// The tokenised school-attendee confirmation flow — `confirm/[token]` — carries a
// one-time secure link and must never be indexed (#2421). A layout keeps the
// tokenised sub-tree noindex in one place. The bare `/school-bookings` page is
// deliberately NOT covered here: it lives in the `(website)` group and is a
// listed, indexable public page.
//
// `public/robots.txt` must NOT disallow the prefix: a disallowed crawler never
// fetches the page, so it never sees this noindex, and could still list a bare
// token URL shared elsewhere.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SchoolBookingsTokenLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
