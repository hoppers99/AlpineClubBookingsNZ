import type { HelpPageContent, HelpPageEntry } from "./types";

/**
 * Public (signed-out) help corpus. Deliberately tiny and generic: it explains
 * how the product works, never invents club policy, and points members at the
 * club's own pages for anything specific. Rules for this file:
 *  - Product mechanics only — how to book, how to join, where to sign in.
 *  - Never state fees, dates, cancellation terms, or any club-specific policy;
 *    defer to the club's own website pages (site menu/footer) and contact page.
 *    Never assert that specific footer content exists — contact details and
 *    quick links are admin-editable and can be saved empty.
 *  - No club proper nouns — always "the club".
 *  - No "AI" or "assistant" wording anywhere in the copy.
 *  - Never state or imply that a non-member can simply book or stay (#2421).
 *    Whether the club hosts non-members at all, and on what terms, is the
 *    club's own policy — defer to its FAQ, rules, or policy pages and its
 *    contact page.
 *  - Never name or link the guest request form, and this rule SURVIVED the form
 *    becoming a real editable page (#2818 decision 1). Advertising it is opt-in
 *    per club: the page ships with an empty menu title, so the default is still
 *    that nothing links to it and search engines are told to ignore it, and the
 *    club hands the URL to a guest it has agreed to host. This corpus is the
 *    same text for every deployment and cannot know which choice a club made, so
 *    naming the form would be wrong for every club that left the default — and
 *    for a club that opted in the form is already in its own site menu, where a
 *    visitor will find it without help copy pointing at it.
 *    `help-corpus.test.ts` guards this.
 */

function entry(path: string, content: HelpPageContent): HelpPageEntry {
  return { path, content };
}

const homeHelp: HelpPageContent = {
  title: "Welcome",
  summary:
    "This is the club's booking website. Members sign in to book a stay and manage their account; if you are not a member yet, you can apply to join. Whether non-members can stay at all is up to the club — check the club's own pages.",
  actions: [
    "Members: use Log In, then open Book to reserve lodge nights.",
    "Not a member yet: use the Join or Apply link to start a membership application.",
    "Not a member and hoping to stay: look for any FAQ, rules, or policy pages the club publishes in the site menu or footer, or use the club's contact page.",
  ],
  questions: [
    {
      q: "How do I book a stay?",
      a: "If you are a member, sign in and open Book to choose your nights and confirm. If you are not a member, apply to join first. Whether non-members can stay is the club's decision — see the club's own pages.",
    },
    {
      q: "How do I become a member?",
      a: "Use the Join or Apply link to fill in a membership application. Applying does not create a login — the club reviews and approves applications before you can sign in.",
    },
    {
      q: "Can I stay without being a member?",
      a: "That is up to the club. Many clubs only host non-members as guests accompanied by a member, if at all. Look for any FAQ, rules, or policy pages the club publishes in the site menu or footer, or contact the club before planning a stay.",
    },
    {
      q: "Where do I find fees, dates, or the cancellation policy?",
      a: "Those are set by the club. Check the club's own pages in the site menu or footer, or use the club's contact page to ask directly.",
    },
  ],
};

export const publicFallbackHelp: HelpPageContent = {
  title: "Help",
  summary:
    "This is the club's public website. Use the menu to find pages about the club, membership, and contact details. Members sign in to book and manage their account.",
  actions: [
    "Use the site menu to reach the club's public pages.",
    "Members: use Log In to reach your dashboard and booking tools.",
    "Use the club's contact page or the site menu links to ask anything specific.",
  ],
  questions: [
    {
      q: "How do I sign in?",
      a: "Use the Log In link. If you have forgotten your password, use the Forgot password link on the sign-in page.",
    },
    {
      q: "How do I join or book?",
      a: "Use the Join or Apply link to start a membership application. Members sign in and open Book to reserve nights. Whether non-members can stay is up to the club — check the club's own pages or use the club's contact page.",
    },
    {
      q: "Who do I contact for something specific?",
      a: "The club sets its own fees, dates, and policies. Use the club's contact page or the pages in the site menu to reach the club directly.",
    },
  ],
};

export const publicHelpEntries: HelpPageEntry[] = [entry("/", homeHelp)];
