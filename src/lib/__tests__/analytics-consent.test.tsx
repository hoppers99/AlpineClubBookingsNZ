// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsConsent } from "@/components/analytics-consent";
import {
  ANALYTICS_PREFERENCES_ATTRIBUTE,
  ANALYTICS_PREFERENCES_AVAILABILITY_EVENT,
  ANALYTICS_PREFERENCES_OPEN_EVENT,
} from "@/lib/analytics-preferences-channel";
import type { AnalyticsRuntimeConfig } from "@/lib/analytics-settings-shared";

/**
 * The public Google Analytics runtime (#2573): the prior-consent guarantee, the
 * banner-disabled mode, the visitor preferences panel, and the URL sanitisation.
 *
 * `next/script` is replaced with a plain element so the test can see WHETHER a script
 * would be injected and with what — the guarantee under test is that nothing renders
 * at all before consent, so the absence of that element is the assertion.
 */

vi.mock("next/script", () => ({
  default: ({
    children,
    id,
    nonce,
    src,
  }: {
    children?: ReactNode;
    id?: string;
    nonce?: string;
    src?: string;
  }) => (
    <div data-testid={id} id={id} data-nonce={nonce} data-src={src}>
      {children}
    </div>
  ),
}));

const mockPathname = vi.hoisted(() => ({ value: "/contact" as string | null }));
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname.value,
}));

const BANNER_ON: AnalyticsRuntimeConfig = {
  measurementId: "G-TEST123456",
  consentBannerEnabled: true,
  bannerMessage: "We use optional Google Analytics on this website.",
  consentRevision: 1,
  privacyPolicyPath: "/privacy",
};

const BANNER_OFF: AnalyticsRuntimeConfig = {
  ...BANNER_ON,
  consentBannerEnabled: false,
};

const STORAGE_KEY = "analytics-consent.v2";

function analyticsLoader() {
  return document.querySelector<HTMLElement>("#ga4-loader");
}

/** Every `gtag(...)` call that has been queued, as flat argument arrays. */
function queuedCalls(): unknown[][] {
  return (window.dataLayer ?? []) as unknown[][];
}

function consentCalls() {
  return queuedCalls().filter((entry) => entry[0] === "consent");
}

function pageViewCalls() {
  return queuedCalls().filter(
    (entry) => entry[0] === "event" && entry[1] === "page_view",
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.dataLayer = undefined;
  window.gtag = undefined;
  // Document-scoped, exactly like `dataLayer`, so it has to be reset with it: a real
  // browser gets a fresh document per page load, and jsdom hands every test in this
  // file the same one. Leaving it set would make the next test's first consent push an
  // `update` when a fresh document would have sent a `default`.
  window.__analyticsConsentDefaultPushed = undefined;
  mockPathname.value = "/contact";
  document.querySelectorAll("script[data-fixture]").forEach((el) => el.remove());
  document.documentElement.removeAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123456"];
});

describe("no configuration means no analytics at all", () => {
  it("renders nothing when the server resolved no config", () => {
    const { container } = render(<AnalyticsConsent config={null} nonce="n-1" />);

    expect(container.innerHTML).toBe("");
    expect(analyticsLoader()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.dataLayer).toBeUndefined();
    expect(
      document.documentElement.getAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE),
    ).toBeNull();
  });
});

describe("banner enabled — PRIOR CONSENT", () => {
  it("shows the banner and loads NOTHING before the visitor accepts", async () => {
    render(<AnalyticsConsent config={BANNER_ON} nonce="n-1" />);

    expect(
      await screen.findByRole("dialog", { name: "Analytics cookie consent" }),
    ).toBeTruthy();
    // The guarantee, stated as four separate absences: no tag, no request, no
    // cookieless ping, no consent-status signal reaching Google. Nothing is sent
    // until `gtag/js` itself is fetched, and no element that would fetch it exists.
    expect(analyticsLoader()).toBeNull();
    expect(document.querySelector('[data-src*="googletagmanager"]')).toBeNull();
    expect(pageViewCalls()).toHaveLength(0);
    // A `consent default` IS queued — a local array push, not a network call — and it
    // must deny analytics storage.
    expect(consentCalls()).toEqual([
      [
        "consent",
        "default",
        {
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          analytics_storage: "denied",
        },
      ],
    ]);
    // Nothing configures a measurement ID either, so even a tag loaded by something
    // else on the page could not attribute an event.
    expect(queuedCalls().some((entry) => entry[0] === "config")).toBe(false);
  });

  it("renders the admin-authored message as text, never as markup", () => {
    render(
      <AnalyticsConsent
        config={{
          ...BANNER_ON,
          bannerMessage: '<img src=x onerror="alert(1)"> & **bold**',
        }}
      />,
    );

    const banner = screen.getByRole("dialog", {
      name: "Analytics cookie consent",
    });
    expect(banner.querySelector("img")).toBeNull();
    expect(banner.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(banner.textContent).toContain("**bold**");
  });

  it("loads the tag only after Accept, and stores the choice with the revision", async () => {
    render(
      <AnalyticsConsent
        config={{ ...BANNER_ON, consentRevision: 4 }}
        nonce="n-1"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
    expect(analyticsLoader()?.getAttribute("data-src")).toBe(
      "https://www.googletagmanager.com/gtag/js?id=G-TEST123456",
    );
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      choice: "accepted",
      revision: 4,
      source: "banner",
    });
    expect(consentCalls().at(-1)).toEqual([
      "consent",
      "update",
      {
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "granted",
      },
    ]);
    expect(screen.queryByRole("dialog", { name: "Analytics cookie consent" })).toBeNull();
  });

  it("turns Google's own automatic page view OFF when it configures the tag", async () => {
    render(<AnalyticsConsent config={BANNER_ON} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(queuedCalls().some((entry) => entry[0] === "config")).toBe(true),
    );
    const configCall = queuedCalls().find((entry) => entry[0] === "config");
    expect(configCall?.[1]).toBe("G-TEST123456");
    // Without this Google would send `location.href`, query string and all.
    expect(configCall?.[2]).toMatchObject({
      send_page_view: false,
      anonymize_ip: true,
    });
  });

  it("queues consent before the tag configuration, so no event is unattributed", async () => {
    render(<AnalyticsConsent config={BANNER_ON} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    await waitFor(() => expect(pageViewCalls()).toHaveLength(1));
    const verbs = queuedCalls().map((entry) => String(entry[0]));
    expect(verbs.indexOf("consent")).toBeLessThan(verbs.indexOf("config"));
    expect(verbs.indexOf("config")).toBeLessThan(verbs.lastIndexOf("event"));
  });

  it.each([
    ["Decline", "Decline"],
    ["dismissal", "Close analytics consent banner"],
  ])("treats %s as a decline and never loads the tag", async (_label, name) => {
    render(<AnalyticsConsent config={BANNER_ON} />);

    fireEvent.click(await screen.findByRole("button", { name }));

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      choice: "declined",
      revision: 1,
      source: "banner",
    });
    expect(analyticsLoader()).toBeNull();
    expect(pageViewCalls()).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: "Analytics cookie consent" })).toBeNull();
  });

  it("honours a stored accept without re-showing the banner", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "accepted", revision: 1, source: "banner" }),
    );

    render(<AnalyticsConsent config={BANNER_ON} />);

    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
    expect(screen.queryByRole("dialog", { name: "Analytics cookie consent" })).toBeNull();
  });

  it("re-prompts, and loads nothing, after the admin bumps the consent revision", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "accepted", revision: 1, source: "banner" }),
    );

    render(<AnalyticsConsent config={{ ...BANNER_ON, consentRevision: 2 }} />);

    expect(
      await screen.findByRole("dialog", { name: "Analytics cookie consent" }),
    ).toBeTruthy();
    expect(analyticsLoader()).toBeNull();
  });
});

describe("banner disabled", () => {
  it("loads automatically, shows no prompt, and keeps advertising denied", async () => {
    render(<AnalyticsConsent config={BANNER_OFF} />);

    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
    expect(screen.queryByRole("dialog", { name: "Analytics cookie consent" })).toBeNull();
    expect(consentCalls()[0]?.[2]).toEqual({
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "granted",
    });
  });

  it("ignores a decline recorded while the banner was showing", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "declined", revision: 1, source: "banner" }),
    );

    render(<AnalyticsConsent config={BANNER_OFF} />);

    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
  });

  it("still honours an opt-out made through the preferences control", async () => {
    // Owner clarification 1: banner-off mode must not make the preferences control
    // ineffective.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "declined", revision: 1, source: "preferences" }),
    );

    render(<AnalyticsConsent config={BANNER_OFF} />);

    await waitFor(() =>
      expect(
        document.documentElement.getAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE),
      ).toBe("available"),
    );
    expect(analyticsLoader()).toBeNull();
  });
});

describe("leaving the public website", () => {
  /*
    The runtime is mounted by the two public WEBSITE layouts only, and the public
    header's own links are soft navigations into groups that mount nothing — "Log In"
    to `/login`, "Dashboard" and "Book Now" to the member area. React unmounts this
    component there, and unmounting a `<Script>` cannot unload an executed library, so
    an unmount that left the tag enabled would keep collecting across exactly the
    routes owner section 7 excludes.
  */
  it("disables the tag on unmount, because unmounting cannot unload it", async () => {
    const { unmount } = render(<AnalyticsConsent config={BANNER_OFF} />);
    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
    expect(
      (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123456"],
    ).toBe(false);

    unmount();

    expect(
      (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123456"],
    ).toBe(true);
    expect(consentCalls().at(-1)).toEqual([
      "consent",
      "update",
      {
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "denied",
      },
    ]);
  });

  it("queues nothing on unmount when it never bootstrapped gtag", () => {
    // Banner showing, storage not yet resolved… but more to the point: a component
    // that never created `window.dataLayer` must not create one on the way out.
    const { unmount } = render(<AnalyticsConsent config={null} />);
    unmount();

    expect(window.dataLayer).toBeUndefined();
  });
});

describe("an opt-out in another tab", () => {
  it("is honoured here too, rather than only in the tab that made it", async () => {
    // The choice is stored per BROWSER, so it has to take effect in every tab of it.
    // Without this the other tab's resident tag keeps sending the events GA4 collects
    // on its own, while the panel has just promised collection stopped.
    render(<AnalyticsConsent config={BANNER_OFF} />);
    await waitFor(() => expect(analyticsLoader()).not.toBeNull());

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "declined", revision: 1, source: "preferences" }),
    );
    fireEvent(
      window,
      new StorageEvent("storage", { key: STORAGE_KEY }),
    );

    await waitFor(() => expect(analyticsLoader()).toBeNull());
    expect(
      (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123456"],
    ).toBe(true);
    expect(consentCalls().at(-1)?.[2]).toMatchObject({
      analytics_storage: "denied",
    });
  });

  it("works in the other direction, so an Accept elsewhere needs no reload", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "declined", revision: 1, source: "banner" }),
    );
    render(<AnalyticsConsent config={BANNER_ON} />);
    await waitFor(() =>
      expect(
        document.documentElement.getAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE),
      ).toBe("available"),
    );
    expect(analyticsLoader()).toBeNull();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "accepted", revision: 1, source: "preferences" }),
    );
    fireEvent(window, new StorageEvent("storage", { key: STORAGE_KEY }));

    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
  });

  it("ignores a write to an unrelated storage key", async () => {
    render(<AnalyticsConsent config={BANNER_OFF} />);
    await waitFor(() => expect(analyticsLoader()).not.toBeNull());

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "declined", revision: 1, source: "preferences" }),
    );
    fireEvent(window, new StorageEvent("storage", { key: "theme" }));

    // Not re-read, so the tag is untouched: this is what stops an unrelated key's
    // churn re-running the decision on every tab.
    expect(analyticsLoader()).not.toBeNull();
  });
});

describe("the privacy policy, linked at the point of the decision", () => {
  it("is linked from the banner and from the preferences panel", async () => {
    render(<AnalyticsConsent config={BANNER_ON} />);

    const banner = await screen.findByRole("dialog", {
      name: "Analytics cookie consent",
    });
    const bannerLink = banner.querySelector('a[href="/privacy"]');
    expect(bannerLink?.textContent).toBe("Privacy policy");

    fireEvent(window, new CustomEvent(ANALYTICS_PREFERENCES_OPEN_EVENT));
    const panel = await screen.findByRole("dialog", {
      name: /Analytics preferences/,
    });
    expect(panel.querySelector('a[href="/privacy"]')).not.toBeNull();
  });

  it("links nothing when the club has no published privacy policy", async () => {
    // A consent banner must not offer a link to a 404, and the admin panel is where
    // the club is told to publish one.
    render(
      <AnalyticsConsent config={{ ...BANNER_ON, privacyPolicyPath: null }} />,
    );

    const banner = await screen.findByRole("dialog", {
      name: "Analytics cookie consent",
    });
    expect(banner.querySelector("a")).toBeNull();
  });
});

describe("the public preferences control", () => {
  async function openPanel(config: AnalyticsRuntimeConfig) {
    render(<AnalyticsConsent config={config} />);
    await waitFor(() =>
      expect(
        document.documentElement.getAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE),
      ).toBe("available"),
    );
    fireEvent(window, new CustomEvent(ANALYTICS_PREFERENCES_OPEN_EVENT));
    return screen.findByRole("dialog", { name: /Analytics preferences/ });
  }

  it("is offered in banner-enabled mode too", async () => {
    expect(await openPanel(BANNER_ON)).toBeTruthy();
  });

  it.each([
    // A page where the runtime really is mounted but analytics is ineligible: the
    // three (website-dynamic) pages carry a PIN or a token, so the tag never runs
    // there — and those are the visitors most likely to want the opt-out.
    "/join/verify/tok_secret123",
    "/hut-leader-instructions",
    "/dashboard",
  ])(
    "is offered on %s, a route analytics does not run on, so opting out is always reachable",
    async (pathname) => {
      // A visitor who wants to switch analytics off should not have to find a tracked
      // page first. Only the banner and the tag are route-gated — pinned here because
      // "restoring" a route gate on availability would silently delete the visitor's
      // only opt-out in banner-off mode.
      mockPathname.value = pathname;
      expect(await openPanel(BANNER_OFF)).toBeTruthy();
      expect(analyticsLoader()).toBeNull();
    },
  );

  it("records an opt-out, sets Google's kill switch, and unmounts the tag", async () => {
    await openPanel(BANNER_OFF);
    await waitFor(() => expect(analyticsLoader()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Turn analytics off" }));

    await waitFor(() => expect(analyticsLoader()).toBeNull());
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      choice: "declined",
      revision: 1,
      source: "preferences",
    });
    // Unmounting the element does not unload a library the browser already executed,
    // so the documented per-ID kill switch is what stops further collection.
    expect(
      (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123456"],
    ).toBe(true);
    expect(consentCalls().at(-1)?.[2]).toMatchObject({
      analytics_storage: "denied",
    });
  });

  it("records an opt-in and loads the tag from a declined state", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "declined", revision: 1, source: "banner" }),
    );
    await openPanel(BANNER_ON);

    fireEvent.click(screen.getByRole("button", { name: "Allow analytics" }));

    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      choice: "accepted",
      revision: 1,
      source: "preferences",
    });
  });

  it("never claims data already sent to Google has been removed", async () => {
    const panel = await openPanel(BANNER_OFF);
    expect(panel.textContent).toContain(
      "It does not remove information already sent to Google.",
    );
    expect(panel.textContent).not.toMatch(/delete|erase|compliant/i);
  });

  /*
    A REFUSED write must not be reported as a stored choice.

    Storage-blocked contexts (private browsing, partitioned or embedded storage,
    zero quota) throw on `setItem` AND `getItem` together, so the choice cannot
    come back on the next page load. In banner-OFF mode that is fail-OPEN:
    `resolveAnalyticsDecision` answers "allowed" with no stored record, so the
    opt-out holds for this page and then quietly stops holding — while the panel
    has just said "switching analytics off stops further collection from this
    browser". Owner section 5 asks for the opt-out to be preserved for future
    eligible page loads, and this implementation cannot preserve it there; what it
    can do is stop claiming otherwise.
  */
  describe("when the browser refuses to store the choice", () => {
    /*
      `Storage.prototype`, not `window.localStorage`: jsdom implements the instance
      as a Proxy whose traps forward to the prototype methods, so an instance spy
      installs a property the proxy never consults and the real store answers
      normally. Measured — with the instance seam this test's block does not fire at
      all, and the assertions below pass for the wrong reason.
      `analytics-consent-storage.test.ts` carries the same helper and the same note.
    */
    function blockStorageWrites() {
      return vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("SecurityError: storage is not available");
      });
    }

    it("keeps the panel open and says the choice will not be remembered", async () => {
      const spy = blockStorageWrites();
      try {
        await openPanel(BANNER_OFF);
        await waitFor(() => expect(analyticsLoader()).not.toBeNull());

        fireEvent.click(screen.getByRole("button", { name: "Turn analytics off" }));

        // The choice IS honoured for this page: the tag goes and the kill switch is set.
        await waitFor(() => expect(analyticsLoader()).toBeNull());
        expect(
          (window as unknown as Record<string, unknown>)[
            "ga-disable-G-TEST123456"
          ],
        ).toBe(true);

        // …and the panel stays open carrying the honest note, rather than dismissing
        // itself on a choice that will not survive the next page load.
        const panel = screen.getByRole("dialog", {
          name: /Analytics preferences/,
        });
        expect(panel.textContent).toContain(
          "This browser would not let us save your choice",
        );
        expect(panel.textContent).toContain(
          "will not be remembered the next time you visit",
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("closes the panel as usual once the write lands", async () => {
      // The mirror case, so "stays open" cannot pass by the panel simply never
      // closing.
      await openPanel(BANNER_OFF);
      fireEvent.click(screen.getByRole("button", { name: "Turn analytics off" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: /Analytics preferences/ }),
        ).toBeNull(),
      );
    });

    it("shows nothing about storage when the write succeeded", async () => {
      const panel = await openPanel(BANNER_ON);
      expect(panel.textContent).not.toMatch(/would not let us save/i);
    });
  });
});

describe("route policy and URL sanitisation, enforced at the runtime", () => {
  it.each([
    "/admin/members/mem_123",
    "/dashboard",
    "/pay/tok_secret",
    "/reset-password",
    "/join/verify/tok_secret",
  ])("loads nothing and sends nothing on %s", async (pathname) => {
    mockPathname.value = pathname;

    render(<AnalyticsConsent config={BANNER_OFF} />);

    await waitFor(() =>
      expect(
        document.documentElement.getAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE),
      ).toBe("available"),
    );
    expect(analyticsLoader()).toBeNull();
    expect(pageViewCalls()).toHaveLength(0);
    // The banner is route-gated too: an excluded page must not ask a question whose
    // answer it would never act on.
    expect(screen.queryByRole("dialog", { name: "Analytics cookie consent" })).toBeNull();
  });

  it("fails closed when no router context is mounted", async () => {
    mockPathname.value = null;

    render(<AnalyticsConsent config={BANNER_OFF} />);

    await waitFor(() => expect(window.dataLayer).toBeDefined());
    expect(analyticsLoader()).toBeNull();
    expect(pageViewCalls()).toHaveLength(0);
  });

  it("sends one sanitised origin+pathname page view, with no query and no fragment", async () => {
    mockPathname.value = "/about-the-club";

    render(<AnalyticsConsent config={BANNER_OFF} />);

    await waitFor(() => expect(pageViewCalls()).toHaveLength(1));
    const payload = pageViewCalls()[0]?.[2] as Record<string, unknown>;
    expect(payload.page_location).toBe(`${window.location.origin}/about-the-club`);
    expect(String(payload.page_location)).not.toContain("?");
    expect(String(payload.page_location)).not.toContain("#");
    // `set` mirrors the same values so Google's own enhanced-measurement events
    // inherit them rather than reading `location.href` for themselves.
    expect(queuedCalls().some((entry) => entry[0] === "set")).toBe(true);
  });

  it("sends exactly one page view per address across client-side navigation", async () => {
    mockPathname.value = "/contact";
    const { rerender } = render(<AnalyticsConsent config={BANNER_OFF} />);
    await waitFor(() => expect(pageViewCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(
        (window as unknown as Record<string, unknown>)[
          "ga-disable-G-TEST123456"
        ],
      ).toBe(false),
    );

    // A re-render with no navigation must not duplicate the view.
    rerender(<AnalyticsConsent config={BANNER_OFF} />);
    await waitFor(() => expect(pageViewCalls()).toHaveLength(1));

    mockPathname.value = "/about";
    rerender(<AnalyticsConsent config={BANNER_OFF} />);
    await waitFor(() => expect(pageViewCalls()).toHaveLength(2));

    // Navigating to an EXCLUDED route sends nothing…
    mockPathname.value = "/dashboard";
    rerender(<AnalyticsConsent config={BANNER_OFF} />);
    await waitFor(() => expect(pageViewCalls()).toHaveLength(2));
    // A route transition can leave the already-executed Google library resident in
    // the document. The per-id kill switch is therefore the privacy boundary, not
    // whether Next removes its injected script node.
    await waitFor(() =>
      expect(
        (window as unknown as Record<string, unknown>)[
          "ga-disable-G-TEST123456"
        ],
      ).toBe(true),
    );

    // …and coming back to an address already reported sends nothing either.
    mockPathname.value = "/about";
    rerender(<AnalyticsConsent config={BANNER_OFF} />);
    await waitFor(() => expect(pageViewCalls()).toHaveLength(2));
    await waitFor(() =>
      expect(
        (window as unknown as Record<string, unknown>)[
          "ga-disable-G-TEST123456"
        ],
      ).toBe(false),
    );
  });

  it("reduces a token-bearing same-origin referrer to the origin", async () => {
    // The concrete leak: a visitor who landed on /pay/<token> and clicked through
    // would otherwise have handed Google the payment token.
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: `${window.location.origin}/pay/tok_secret123`,
    });
    try {
      render(<AnalyticsConsent config={BANNER_OFF} />);
      await waitFor(() => expect(pageViewCalls()).toHaveLength(1));
      const payload = pageViewCalls()[0]?.[2] as Record<string, unknown>;
      expect(payload.page_referrer).toBe(window.location.origin);
      expect(String(payload.page_referrer)).not.toContain("tok_secret123");
    } finally {
      Object.defineProperty(document, "referrer", {
        configurable: true,
        value: "",
      });
    }
  });
});

/**
 * The nonce the loader script is stamped with has to be the LOADED DOCUMENT's, not the
 * one the current render was handed (#2352 D1 review).
 *
 * A document's CSP is fixed when it loads; the `nonce` prop is not. `(website)` passes
 * the fixed per-release value and `(website-dynamic)` the per-request one, so a soft
 * navigation between the two public groups swaps layouts and remounts this component
 * holding the other territory's nonce — while the policy in force is still the one that
 * arrived with the document. The loader is `afterInteractive`, i.e. injected by the
 * browser at that moment and nonce-checked (`script-src` carries no `'strict-dynamic'`),
 * so reading the prop meant gtag was silently refused.
 *
 * #2573 removed the two INLINE scripts this used to be asserted on — every `gtag` call
 * now happens in the bundle — so the assertions moved to the one external `<Script src>`
 * that is left. It still needs the nonce, and the reader is unchanged.
 */
describe("AnalyticsConsent nonce source", () => {
  function addDocumentScript(nonce: string) {
    const script = document.createElement("script");
    script.setAttribute("data-fixture", "");
    script.setAttribute("nonce", nonce);
    document.head.appendChild(script);
  }

  async function loaderNonce() {
    // Banner OFF so the loader renders without a click: this suite is about the
    // nonce, not about consent.
    render(<AnalyticsConsent config={BANNER_OFF} nonce="stale-prop-nonce" />);
    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
    return analyticsLoader()?.getAttribute("data-nonce");
  }

  it("prefers the document's nonce over the prop it was rendered with", async () => {
    addDocumentScript("doc-nonce");
    await expect(loaderNonce()).resolves.toBe("doc-nonce");
  });

  it("falls back to the prop when the document carries no nonce at all", async () => {
    // `next start` with no proxy in front of it, or any policy without a nonce. The
    // prop is still the best available answer; an empty attribute would be worse.
    await expect(loaderNonce()).resolves.toBe("stale-prop-nonce");
  });

  it("reads the IDL property when CSP nonce hiding has blanked the attribute", async () => {
    // This is what a real browser looks like: once the document is parsed the nonce
    // CONTENT attribute is emptied and the value survives only on the element's
    // `nonce` IDL property. jsdom does not implement hiding, so it is simulated with
    // an own property that shadows the reflecting accessor — otherwise this file could
    // only ever exercise the `getAttribute` path and a browser-only bug would sit here
    // undetected. A reader that trusted `getAttribute` alone would stamp nothing and
    // the loader would be refused on every page.
    const hidden = document.createElement("script");
    hidden.setAttribute("data-fixture", "");
    hidden.setAttribute("nonce", "");
    Object.defineProperty(hidden, "nonce", {
      value: "doc-nonce",
      configurable: true,
    });
    document.head.appendChild(hidden);

    await expect(loaderNonce()).resolves.toBe("doc-nonce");
  });

  it("skips a script with no nonce and keeps looking", async () => {
    // Next's own bootstrap scripts are not the only scripts on the page; a widget
    // script with no nonce must not end the search with an empty answer.
    const unnonced = document.createElement("script");
    unnonced.setAttribute("data-fixture", "");
    document.head.appendChild(unnonced);
    addDocumentScript("doc-nonce");

    await expect(loaderNonce()).resolves.toBe("doc-nonce");
  });
});

describe("the consent position survives a cross-group round trip", () => {
  /*
    The visitor accepts on the public website, soft-navigates into a group that mounts
    no analytics runtime (the header's own "Log In" and "Dashboard" links do exactly
    this), then comes back to a website page.

    gtag honours `consent default` only BEFORE the library initialises. A second
    `default` pushed by the remounted instance is ignored, so if that is what it pushes
    the tag stays on the DENIAL the unmount queued — analytics degraded to cookieless
    pings for someone who explicitly accepted. The last consent signal has to be an
    `update` that grants.
  */
  it("re-grants with an update, not an ignored second default", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice: "accepted", revision: 1, source: "banner" }),
    );

    const first = render(<AnalyticsConsent config={BANNER_ON} nonce="n-1" />);
    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
    first.unmount();
    // Leaving the website disables the resident tag.
    expect(
      (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123456"],
    ).toBe(true);

    // Coming back mounts a fresh instance in the SAME document, where the gtag library
    // is still resident.
    render(<AnalyticsConsent config={BANNER_ON} nonce="n-1" />);
    await waitFor(() => expect(analyticsLoader()).not.toBeNull());

    const last = consentCalls().at(-1);
    expect(last?.[1]).toBe("update");
    expect(last?.[2]).toMatchObject({
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    expect(
      (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123456"],
    ).toBe(false);
    // Exactly one `default` in the whole document, and it is the first thing queued.
    expect(consentCalls().filter((entry) => entry[1] === "default")).toHaveLength(1);
    expect(consentCalls()[0]?.[1]).toBe("default");
  });
});

describe("opting out and back in on the same page", () => {
  it("sends a page view again for the address the visitor is still on", async () => {
    mockPathname.value = "/about";
    render(<AnalyticsConsent config={BANNER_OFF} nonce="n-1" />);
    await waitFor(() => expect(pageViewCalls()).toHaveLength(1));

    fireEvent(window, new CustomEvent(ANALYTICS_PREFERENCES_OPEN_EVENT));
    fireEvent.click(await screen.findByRole("button", { name: "Turn analytics off" }));
    await waitFor(() => expect(analyticsLoader()).toBeNull());
    // Nothing further while it is off.
    expect(pageViewCalls()).toHaveLength(1);

    fireEvent(window, new CustomEvent(ANALYTICS_PREFERENCES_OPEN_EVENT));
    fireEvent.click(await screen.findByRole("button", { name: "Allow analytics" }));
    await waitFor(() => expect(analyticsLoader()).not.toBeNull());

    // GA4 needs a page view to open the session, so the re-grant sends one for the
    // page the visitor never left rather than waiting for their next navigation.
    await waitFor(() => expect(pageViewCalls()).toHaveLength(2));
    for (const call of pageViewCalls()) {
      expect(call[2]).toMatchObject({ page_location: "http://localhost:3000/about" });
    }
  });

  /*
    The other half of the same boundary, pinned so the fix above cannot be widened by
    accident. An INELIGIBLE ADDRESS is not a consent event: stepping onto one and back
    must still send nothing, which is what the de-duplication in owner section 7 is for.
    Only a withdrawal of consent forgets what was already reported.
  */
  it("does not re-report an address after a detour through an ineligible one", async () => {
    mockPathname.value = "/about";
    const { rerender } = render(<AnalyticsConsent config={BANNER_OFF} nonce="n-1" />);
    await waitFor(() => expect(pageViewCalls()).toHaveLength(1));

    // An unbroken alphanumeric run: served by the website catch-all, so the component
    // stays MOUNTED, but refused by the route policy as a possible identifier.
    mockPathname.value = "/newsletter2026spring";
    rerender(<AnalyticsConsent config={BANNER_OFF} nonce="n-1" />);
    await waitFor(() => expect(analyticsLoader()).toBeNull());
    expect(pageViewCalls()).toHaveLength(1);

    mockPathname.value = "/about";
    rerender(<AnalyticsConsent config={BANNER_OFF} nonce="n-1" />);
    await waitFor(() => expect(analyticsLoader()).not.toBeNull());
    expect(pageViewCalls()).toHaveLength(1);
  });
});

describe("leaving the website withdraws the preferences control", () => {
  /*
    The footer that carries the Analytics preferences link is rendered by the
    `(public)` layout as well — the login, recovery and token-bearing group, which
    mounts no analytics runtime. So a link left offered there is a button with nothing
    behind it: the panel it opens belongs to the component that has just unmounted.
  */
  it("clears the attribute and announces it when the runtime unmounts", async () => {
    const announced: boolean[] = [];
    const listener = (event: Event) => {
      announced.push(
        Boolean((event as CustomEvent<{ available?: boolean }>).detail?.available),
      );
    };
    window.addEventListener(ANALYTICS_PREFERENCES_AVAILABILITY_EVENT, listener);

    try {
      const { unmount } = render(<AnalyticsConsent config={BANNER_ON} nonce="n-1" />);
      await waitFor(() =>
        expect(
          document.documentElement.getAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE),
        ).toBe("available"),
      );
      expect(announced.at(-1)).toBe(true);

      unmount();

      expect(
        document.documentElement.getAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE),
      ).toBeNull();
      // Both channels agree: a listener that never re-reads the attribute is still told.
      expect(announced.at(-1)).toBe(false);
    } finally {
      window.removeEventListener(
        ANALYTICS_PREFERENCES_AVAILABILITY_EVENT,
        listener,
      );
    }
  });
});
