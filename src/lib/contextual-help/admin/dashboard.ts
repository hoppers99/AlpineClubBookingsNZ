/**
 * Help for the admin dashboard — the landing page, and its own section in the
 * sidebar.
 */
import { entry, help, type HelpEntry } from "../types";

export const adminDashboardHelpEntries: HelpEntry[] = [
  entry(
    "/admin/dashboard",
    help(
      "Admin Dashboard",
      "The dashboard is the starting point for operational triage across bookings, members, lodge tasks, payments, Xero, and support signals.",
      [
        "Review queue counts and warning panels before opening a specific workflow.",
        "Follow links from cards to the underlying queue or detail page.",
        "Use the Needs Attention menu for work that currently has pending records.",
      ],
      [
        {
          name: "Needs attention",
          description:
            "Highlights queues that require operator action, such as applications, refunds, issues, and hut-leader gaps.",
        },
        {
          name: "Recent activity",
          description:
            "Shows current operational signals so admins can decide which workflow to open next.",
        },
      ],
    ),
  ),
];
