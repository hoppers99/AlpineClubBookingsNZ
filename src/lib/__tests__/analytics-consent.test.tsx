// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsConsent } from "@/components/analytics-consent";

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

function analyticsLoader() {
  return document.querySelector<HTMLElement>("#ga4-loader");
}

describe("AnalyticsConsent", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.dataLayer = undefined;
    window.gtag = undefined;
  });

  it("does not render scripts or a banner until the module and measurement id are present", () => {
    render(<AnalyticsConsent enabled measurementId="" nonce="nonce-1" />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[data-testid]")).toBeNull();
  });

  it("shows the opt-in banner with default-denied consent and no GA loader", async () => {
    render(<AnalyticsConsent enabled measurementId="G-TEST123" nonce="nonce-1" />);

    expect(await screen.findByRole("dialog", { name: "Analytics cookie consent" })).toBeTruthy();
    expect(screen.getByTestId("ga-consent-default").getAttribute("data-nonce"))
      .toBe("nonce-1");
    expect(analyticsLoader()).toBeNull();
  });

  it("loads GA4 only after accept and stores the choice", async () => {
    render(<AnalyticsConsent enabled measurementId="G-TEST123" nonce="nonce-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(analyticsLoader()).not.toBeNull();
    });
    expect(analyticsLoader()?.getAttribute("data-src")).toContain(
      "https://www.googletagmanager.com/gtag/js?id=G-TEST123",
    );
    expect(window.localStorage.getItem("analytics-consent.v1")).toBe("accepted");
    expect(window.dataLayer).toContainEqual([
      "consent",
      "update",
      { analytics_storage: "granted" },
    ]);
  });

  it("persists decline without loading GA4", async () => {
    render(<AnalyticsConsent enabled measurementId="G-TEST123" />);

    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

    expect(window.localStorage.getItem("analytics-consent.v1")).toBe("declined");
    expect(analyticsLoader()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("honors a stored accept without showing the banner again", async () => {
    window.localStorage.setItem("analytics-consent.v1", "accepted");

    render(<AnalyticsConsent enabled measurementId="G-TEST123" />);

    await waitFor(() => {
      expect(analyticsLoader()).not.toBeNull();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * The nonce these scripts are stamped with has to be the LOADED DOCUMENT's, not the
 * one the current render was handed (#2352 D1 review).
 *
 * A document's CSP is fixed when it loads; the `nonce` prop is not. `(website)` passes
 * the fixed per-release value and `(website-dynamic)` the per-request one, so a soft
 * navigation between the two public groups swaps layouts and remounts this component
 * holding the other territory's nonce — while the policy in force is still the one
 * that arrived with the document. Every script here is `afterInteractive`, i.e.
 * injected by the browser at that moment and nonce-checked (`script-src` carries no
 * `'strict-dynamic'`), so the inline GA config was silently refused: gtag loaded and
 * never configured.
 */
describe("AnalyticsConsent nonce source", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.querySelectorAll("script[data-fixture]").forEach((el) => el.remove());
  });

  function addDocumentScript(nonce: string) {
    const script = document.createElement("script");
    script.setAttribute("data-fixture", "");
    script.setAttribute("nonce", nonce);
    document.head.appendChild(script);
  }

  it("prefers the document's nonce over the prop it was rendered with", async () => {
    // The soft-navigation case: the document was served naming `doc-nonce`, and this
    // mount was handed the other group's `stale-prop-nonce`.
    addDocumentScript("doc-nonce");

    render(
      <AnalyticsConsent
        enabled
        measurementId="G-TEST123"
        nonce="stale-prop-nonce"
      />,
    );

    expect(
      (await screen.findByTestId("ga-consent-default")).getAttribute("data-nonce"),
    ).toBe("doc-nonce");
  });

  it("stamps the document's nonce on the GA4 scripts too", async () => {
    addDocumentScript("doc-nonce");

    render(
      <AnalyticsConsent
        enabled
        measurementId="G-TEST123"
        nonce="stale-prop-nonce"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(analyticsLoader()).not.toBeNull();
    });
    expect(analyticsLoader()?.getAttribute("data-nonce")).toBe("doc-nonce");
    expect(
      screen.getByTestId("ga4-config").getAttribute("data-nonce"),
    ).toBe("doc-nonce");
  });

  it("falls back to the prop when the document carries no nonce at all", async () => {
    // `next start` with no proxy in front of it, or any policy without a nonce. The
    // prop is still the best available answer; an empty attribute would be worse.
    render(
      <AnalyticsConsent enabled measurementId="G-TEST123" nonce="prop-nonce" />,
    );

    expect(
      (await screen.findByTestId("ga-consent-default")).getAttribute("data-nonce"),
    ).toBe("prop-nonce");
  });

  it("reads the IDL property when CSP nonce hiding has blanked the attribute", async () => {
    // This is what a real browser looks like: once the document is parsed, the nonce
    // CONTENT attribute is emptied and the value survives only on the element's
    // `nonce` IDL property. jsdom does not implement hiding, so it is simulated with
    // an own property that shadows the reflecting accessor — otherwise this file
    // could only ever exercise the `getAttribute` path and a browser-only bug would
    // sit here undetected. A reader that trusted `getAttribute` alone would stamp
    // nothing and every script on the page would be refused.
    const hidden = document.createElement("script");
    hidden.setAttribute("data-fixture", "");
    hidden.setAttribute("nonce", "");
    Object.defineProperty(hidden, "nonce", {
      value: "doc-nonce",
      configurable: true,
    });
    document.head.appendChild(hidden);

    render(
      <AnalyticsConsent enabled measurementId="G-TEST123" nonce="prop-nonce" />,
    );

    expect(
      (await screen.findByTestId("ga-consent-default")).getAttribute("data-nonce"),
    ).toBe("doc-nonce");
  });

  it("skips a script with no nonce and keeps looking", async () => {
    // Next's own bootstrap scripts are not the only scripts on the page; a widget
    // script with no nonce must not end the search with an empty answer.
    const unnonced = document.createElement("script");
    unnonced.setAttribute("data-fixture", "");
    document.head.appendChild(unnonced);
    addDocumentScript("doc-nonce");

    render(
      <AnalyticsConsent enabled measurementId="G-TEST123" nonce="prop-nonce" />,
    );

    expect(
      (await screen.findByTestId("ga-consent-default")).getAttribute("data-nonce"),
    ).toBe("doc-nonce");
  });
});
