import { describe, expect, it } from "vitest";
import {
  getContextualHelp,
  getContextualHelpPaths,
} from "@/lib/contextual-help";

describe("contextual help registry", () => {
  it.each([
    ["/admin/members", "search, filters, sort, and page"],
    ["/admin/bookings", "without changing the selected lodge"],
    ["/admin/payments", "rolling three-month Updated range"],
    ["/admin/subscriptions", "without changing the selected season"],
    ["/admin/reports", "without changing the selected lodge"],
  ])("documents dataset Reset behavior for %s", (pathname, expected) => {
    const help = getContextualHelp(pathname, "admin");

    expect(
      help.actions.find((action) => action.startsWith("Use Reset")),
    ).toContain(expected);
  });

  it("returns route-specific admin help", () => {
    const help = getContextualHelp("/admin/members", "admin");

    expect(help.title).toBe("Members");
    expect(help.fields?.map((field) => field.name)).toContain("Access role");
  });

  it("includes the booking status glossary on the bookings page help", () => {
    const help = getContextualHelp("/admin/bookings", "admin");

    const glossary = help.sections?.find(
      (section) => section.title === "Booking status glossary",
    );
    expect(glossary).toBeTruthy();
    expect(glossary?.details.some((d) => d.startsWith("Confirmed (Unpaid)"))).toBe(true);
  });

  it("documents the access-roles admin page with the seven areas", () => {
    const help = getContextualHelp("/admin/access-roles", "admin");

    expect(help.title).toBe("Access roles and admin areas");
    const areaFields = help.fields?.map((field) => field.name);
    expect(areaFields).toEqual([
      "Admin Overview",
      "Bookings & Beds",
      "Membership",
      "Finance",
      "Lodge Operations",
      "Content",
      "Support & System",
    ]);
  });

  it("explains membership-type Xero rule modes in context", () => {
    const help = getContextualHelp("/admin/membership-types", "admin");

    expect(help.title).toBe("Membership Types");
    expect(help.fields?.map((field) => field.name)).toEqual(
      expect.arrayContaining(["Xero rule mode", "Xero age scope"]),
    );

    const xeroRules = help.sections?.find(
      (section) => section.title === "Xero rules",
    );
    expect(xeroRules?.details.join(" ")).toContain(
      "Managed rules actively add matching members",
    );
    expect(xeroRules?.details.join(" ")).toContain(
      "Accepted rules tolerate the selected group",
    );
    expect(xeroRules?.details.join(" ")).toContain(
      "only one Managed rule is allowed",
    );
  });

  it("covers the Wave 5 admin setup and help surfaces", () => {
    const routes = [
      "/admin/hut-leaders",
      "/admin/roster",
      "/admin/setup",
      "/admin/setup/foundations",
      "/admin/setup/finance",
      "/admin/setup/booking-rules",
      "/admin/setup/integrations",
      "/admin/setup/cancellation",
      "/admin/membership-setup",
      "/admin/appearance",
      "/admin/bookings-setup",
      "/admin/integrations",
      "/admin/notifications",
      "/admin/membership-types",
      "/admin/members/member-1",
      "/admin/committee",
      "/admin/access-roles",
      "/admin/book",
    ];

    for (const route of routes) {
      const help = getContextualHelp(route, "admin");
      expect(help.title, `${route} should have route-specific help`).not.toBe(
        "Admin Help",
      );
    }
  });

  it("uses the most specific parent route for nested admin pages", () => {
    const help = getContextualHelp("/admin/xero/setup/provider-test", "admin");

    expect(help.title).toBe("Xero Setup");
    expect(help.fields?.map((field) => field.name)).toContain("Account mapping");
  });

  it("falls back to generic admin help for unmapped admin routes", () => {
    const help = getContextualHelp("/admin/not-yet-documented", "admin");

    expect(help.title).toBe("Admin Help");
    expect(help.actions.length).toBeGreaterThan(0);
  });

  it("returns finance dashboard help for finance routes", () => {
    const help = getContextualHelp("/finance?view=revenue", "finance");

    expect(help.title).toBe("Finance Dashboard");
    expect(help.fields?.map((field) => field.name)).toContain("View");
    expect(help.actions).toContainEqual(
      expect.stringContaining("without changing the current view or lodge scope"),
    );
  });

  it("documents the Reports Next Month quick range and retained filters", () => {
    const help = getContextualHelp("/admin/reports", "admin");

    expect(help.actions.join(" ")).toContain("Next Month");
    expect(
      help.fields?.find((field) => field.name === "Quick Range")?.description,
    ).toContain("without changing the Lodge or Deleted filters");

    const metricContract = help.sections?.find(
      (section) => section.title === "How report metrics are counted",
    );
    const details = metricContract?.details.join(" ") ?? "";
    expect(details).toContain(
      "across every lodge night in its complete stay, with any remainder assigned deterministically, before the selected date range is sliced",
    );
    expect(details).toContain("allocated booking value, not collected cash");
    expect(details).toContain("captured payment amount less refunds");
    expect(details).toContain("Outstanding Additions is shown separately");
    expect(details).toContain(
      "Pending, Payment Pending, Confirmed, Paid, Awaiting Review, and Completed",
    );
    expect(details).toContain("only Paid and Completed bookings occupy beds");
    expect(details).toContain("custodian bed holds remain excluded");
  });

  it("covers the primary admin and finance menu surfaces", () => {
    expect(getContextualHelpPaths("admin")).toEqual(
      expect.arrayContaining([
        "/admin/dashboard",
        "/admin/bookings",
        "/admin/members",
        "/admin/membership-setup",
        "/admin/setup/finance",
        "/admin/setup/booking-rules",
        "/admin/appearance",
        "/admin/bookings-setup",
        "/admin/integrations",
        "/admin/notifications",
        "/admin/site-banners",
        "/admin/xero/setup",
      ]),
    );
    expect(getContextualHelpPaths("finance")).toEqual(["/finance"]);
  });
});
