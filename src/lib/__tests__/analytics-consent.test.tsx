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
