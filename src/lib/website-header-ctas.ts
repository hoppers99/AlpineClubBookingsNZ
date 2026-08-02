/**
 * The two forms the public header's call-to-action pair takes (#2352 D2).
 *
 * Both are resolved on the server and both ship in the stored page; the browser
 * picks one from the sign-in marker cookie. That is the whole of the session
 * dependence the public header ever had — the #2352 planning pass enumerated it:
 * one boolean controlling the account button's label and target, the same pair in
 * the mobile drawer, and the Book Now destination. No member name, email, role or
 * other personal data appears in the public header, which is what makes serving
 * one stored copy to everyone acceptable in the first place.
 *
 * Kept in a plain module (no `server-only`, no `"use client"`) because a server
 * component builds these values and a client component consumes them.
 */

export interface WebsiteHeaderCtaTarget {
  href: string;
  label: string;
}

export interface WebsiteHeaderCtaVariant {
  /** "Log In" → /login, or "Dashboard" → /dashboard. */
  account: WebsiteHeaderCtaTarget;
  /** The Book Now button, or null when the admin has hidden it (E3 #1929). */
  bookNow: WebsiteHeaderCtaTarget | null;
}

export interface WebsiteHeaderCtaVariants {
  anonymous: WebsiteHeaderCtaVariant;
  member: WebsiteHeaderCtaVariant;
}
