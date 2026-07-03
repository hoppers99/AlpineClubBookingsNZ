// Starter editable site content (public footer columns) shared by
// prisma/seed.ts, src/lib/site-content.ts (missing-row fallback), and the
// 20260702124500_add_site_content migration. The migration duplicates these
// values as SQL because production deploys run migrations without the seed;
// src/lib/__tests__/site-content-starter-backfill.test.ts keeps them in sync.
//
// The HTML mirrors the previously hardcoded markup in
// src/components/website-footer.tsx so existing installs see zero visual
// change when the footer becomes admin-editable.
export type StarterSiteContent = {
  key: "FOOTER_BLURB" | "FOOTER_QUICK_LINKS" | "FOOTER_AFFILIATIONS";
  /** Stable row id used by both the seed and the backfill migration. */
  id: string;
  contentHtml: string;
};

const footerBlurbContentHtml =
  "<p>Established 1969. Encouraging tramping, mountaineering, climbing, skiing, and alpine activities in New Zealand.</p>";

const footerQuickLinksContentHtml = [
  "<h3>Quick Links</h3>",
  "<ul>",
  '<li><a href="/about">About the Club</a></li>',
  '<li><a href="/join">Join the Club</a></li>',
  '<li><a href="/faq">FAQ</a></li>',
  '<li><a href="/rules">Club Rules</a></li>',
  '<li><a href="/contact">Contact Us</a></li>',
  '<li><a href="/login">Member Login</a></li>',
  "</ul>",
].join("");

const footerAffiliationsContentHtml = [
  "<h3>Affiliations</h3>",
  "<ul>",
  '<li><a href="https://www.fmc.org.nz/" target="_blank" rel="noopener noreferrer">Federated Mountain Clubs (FMC)</a></li>',
  '<li><a href="https://rmca.org.nz/" target="_blank" rel="noopener noreferrer">Ruapehu Mountain Clubs Association (RMCA)</a></li>',
  '<li><a href="{{facebook-url}}" target="_blank" rel="noopener noreferrer">Facebook</a></li>',
  "</ul>",
].join("");

export const starterSiteContent: readonly StarterSiteContent[] = [
  {
    key: "FOOTER_BLURB",
    id: "site-content-footer-blurb",
    contentHtml: footerBlurbContentHtml,
  },
  {
    key: "FOOTER_QUICK_LINKS",
    id: "site-content-footer-quick-links",
    contentHtml: footerQuickLinksContentHtml,
  },
  {
    key: "FOOTER_AFFILIATIONS",
    id: "site-content-footer-affiliations",
    contentHtml: footerAffiliationsContentHtml,
  },
];
