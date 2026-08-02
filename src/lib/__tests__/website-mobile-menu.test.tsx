// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigationState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
}));

import { WebsiteMobileMenu } from "@/components/website-mobile-menu";
import { SIGNED_IN_HINT_COOKIE, SIGNED_IN_HINT_VALUE } from "@/lib/signed-in-hint";
import type { WebsiteHeaderCtaVariants } from "@/lib/website-header-ctas";

const ctaVariants: WebsiteHeaderCtaVariants = {
  anonymous: {
    account: { href: "/login", label: "Log In" },
    bookNow: { href: "/login?next=/book", label: "Member booking" },
  },
  member: {
    account: { href: "/dashboard", label: "Dashboard" },
    bookNow: { href: "/book", label: "Book Now" },
  },
};

function menu(overrides: Partial<WebsiteHeaderCtaVariants> = {}) {
  return (
    <WebsiteMobileMenu
      clubName="Alpine Club"
      navLinks={[
        { href: "/", label: "Home" },
        { href: "/about", label: "About" },
      ]}
      {...ctaVariants}
      {...overrides}
    />
  );
}

function getDetails(container: HTMLElement) {
  const details = container.querySelector("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Mobile menu details element was not rendered");
  }
  return details;
}

function setSignedInHint() {
  document.cookie = `${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}; path=/`;
}

describe("WebsiteMobileMenu", () => {
  beforeEach(() => {
    navigationState.pathname = "/";
  });

  afterEach(() => {
    document.cookie = `${SIGNED_IN_HINT_COOKIE}=; path=/; max-age=0`;
  });

  it("closes when a mobile menu link is clicked", () => {
    const { container } = render(menu());
    const details = getDetails(container);
    details.open = true;
    const link = screen.getByRole("link", { name: "About" });
    link.addEventListener("click", (event) => event.preventDefault());

    fireEvent.click(link);

    expect(details.open).toBe(false);
  });

  it("closes when the current route changes", async () => {
    const view = render(menu());
    const details = getDetails(view.container);
    details.open = true;

    navigationState.pathname = "/about";
    view.rerender(menu());

    await waitFor(() => expect(details.open).toBe(false));
  });

  // #2430: the drawer renders whatever the resolved CTA variant carries — it never
  // spells a label out itself, so the CTA cannot say one thing on the desktop
  // header and another in the drawer.
  it("renders the resolved CTA label rather than a hard-coded 'Book Now'", () => {
    const { container } = render(menu());
    getDetails(container).open = true;

    expect(
      screen.getByRole("link", { name: "Member booking" }).getAttribute("href"),
    ).toBe("/login?next=/book");
    expect(screen.queryByRole("link", { name: "Book Now" })).toBeNull();
  });

  it("hides the Book Now button when the admin turned it off", () => {
    const { container } = render(
      menu({
        anonymous: { account: ctaVariants.anonymous.account, bookNow: null },
        member: { account: ctaVariants.member.account, bookNow: null },
      }),
    );
    getDetails(container).open = true;

    expect(screen.queryByRole("link", { name: "Member booking" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Book Now" })).toBeNull();
  });

  // #2352 D2: the drawer is inside a page that may be one stored copy served to
  // everyone, so it picks its variant from the non-secret marker cookie rather
  // than from a server-rendered session boolean.
  it("shows the signed-out CTAs when the marker cookie is absent", () => {
    const { container } = render(menu());
    getDetails(container).open = true;

    expect(screen.getByRole("link", { name: "Log In" }).getAttribute("href")).toBe(
      "/login",
    );
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
  });

  it("shows the signed-in CTAs when the marker cookie is present", () => {
    setSignedInHint();

    const { container } = render(menu());
    getDetails(container).open = true;

    expect(
      screen.getByRole("link", { name: "Dashboard" }).getAttribute("href"),
    ).toBe("/dashboard");
    expect(
      screen.getByRole("link", { name: "Book Now" }).getAttribute("href"),
    ).toBe("/book");
    expect(screen.queryByRole("link", { name: "Log In" })).toBeNull();
  });
});
