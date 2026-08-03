// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WebsiteHeaderCtas } from "@/components/website-header-ctas";
import {
  SIGNED_IN_HINT_COOKIE,
  SIGNED_IN_HINT_VALUE,
} from "@/lib/signed-in-hint";
import type { WebsiteHeaderCtaVariants } from "@/lib/website-header-ctas";

/**
 * The desktop header's CTA pair, picked in the browser (#2352 D2).
 *
 * The point of these cases is the SHAPE of the swap, not just its outcome: the
 * stored page is one copy served to everyone, so exactly one account button must be
 * present at a time — a hidden sibling would sit in the accessibility tree until
 * hydration and would change the row's width when the swap happened.
 */
const variants: WebsiteHeaderCtaVariants = {
  anonymous: {
    account: { href: "/login", label: "Log In" },
    bookNow: { href: "/login?next=/book", label: "Member booking" },
  },
  member: {
    account: { href: "/dashboard", label: "Dashboard" },
    bookNow: { href: "/book", label: "Book Now" },
  },
};

describe("WebsiteHeaderCtas", () => {
  afterEach(() => {
    document.cookie = `${SIGNED_IN_HINT_COOKIE}=; path=/; max-age=0`;
  });

  it("renders the signed-out pair when the marker cookie is absent", () => {
    render(<WebsiteHeaderCtas {...variants} />);

    expect(screen.getByRole("link", { name: "Log In" }).getAttribute("href")).toBe(
      "/login",
    );
    expect(
      screen.getByRole("link", { name: "Member booking" }).getAttribute("href"),
    ).toBe("/login?next=/book");
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
  });

  it("renders the signed-in pair when the marker cookie is present", () => {
    document.cookie = `${SIGNED_IN_HINT_COOKIE}=${SIGNED_IN_HINT_VALUE}; path=/`;

    render(<WebsiteHeaderCtas {...variants} />);

    expect(
      screen.getByRole("link", { name: "Dashboard" }).getAttribute("href"),
    ).toBe("/dashboard");
    expect(screen.getByRole("link", { name: "Book Now" }).getAttribute("href")).toBe(
      "/book",
    );
    expect(screen.queryByRole("link", { name: "Log In" })).toBeNull();
  });

  it("shows exactly ONE account button, never both", () => {
    render(<WebsiteHeaderCtas {...variants} />);

    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("ignores a forged value that is not the exact marker", () => {
    document.cookie = `${SIGNED_IN_HINT_COOKIE}=yes; path=/`;

    render(<WebsiteHeaderCtas {...variants} />);

    expect(screen.getByRole("link", { name: "Log In" })).toBeTruthy();
  });

  it("omits the Book Now button entirely when the admin hid it", () => {
    // An admin choice, resolved on the server — so it is the same in both variants
    // and cannot flicker.
    render(
      <WebsiteHeaderCtas
        anonymous={{ account: variants.anonymous.account, bookNow: null }}
        member={{ account: variants.member.account, bookNow: null }}
      />,
    );

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Member booking" })).toBeNull();
  });
});
