// Starter editable site content (public footer columns) shared by
// prisma/seed.ts, src/lib/site-content.ts (missing-row fallback), and the
// 20260702124500_add_site_content migration. The migration duplicates these
// values as SQL because production deploys run migrations without the seed;
// src/lib/__tests__/site-content-starter-backfill.test.ts keeps them in sync.
//
// The HTML mirrored the previously hardcoded markup in
// src/components/website-footer.tsx so existing installs saw zero visual
// change when the footer became admin-editable. FOOTER_AFFILIATIONS has since
// been emptied (#2490) — see the comment above its value.
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

// EMPTY ON PURPOSE (#2490). A club's affiliations are facts about that club,
// so this project cannot know them: the original value listed Federated
// Mountain Clubs and the Ruapehu Mountain Clubs Association because this
// codebase WAS the Tokoroa Alpine Club's live site, and once the repository
// became a reusable product every fresh install began publishing a regional
// body it does not belong to on every public page's footer. A fresh install
// therefore lists no affiliations at all; the footer hides the whole column
// while this section is empty (src/components/website-footer.tsx), so nothing
// renders as a heading over an empty list. An admin adds the club's own links
// under Admin > Site Appearance & Content > Site Content > Footer:
// affiliations.
//
// The historical value is still in 20260702124500_add_site_content, which
// cannot be edited once applied; 20260802140000_clear_starter_footer_affiliations
// clears it from any database that still holds it byte for byte.
const footerAffiliationsContentHtml = "";

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
