/**
 * What an operator is told on a page with no help entry of its own.
 *
 * Generic on purpose: it describes how any admin page works rather than
 * pretending to know this one. `./index.ts` attaches the fallback questions to
 * the fallback content at load, the same way it does for a real entry.
 */
import { help, type HelpQuestion } from "./types";

export const adminFallbackHelp = help(
  "Admin Help",
  "This admin page manages a protected club workflow. Use the page heading, filters, tables, and action buttons to find the record you need, make a deliberate change, and check any confirmation or audit feedback after saving.",
  [
    "Use search, filters, and tabs first so you are changing the right record set.",
    "Open the record detail, dialog, or action button for the smallest change that completes the task.",
    "Read validation errors and confirmation prompts before retrying or approving a destructive action.",
  ],
  [
    {
      name: "Filters",
      description:
        "Narrow long lists by status, date, member, or workflow type before acting.",
    },
    {
      name: "Status",
      description:
        "Shows the record's current lifecycle state and usually controls which actions are available.",
    },
    {
      name: "Reason or notes",
      description:
        "Capture operator context for audit logs and future committee review when the page asks for it.",
    },
  ],
  [
    "Admin actions can affect bookings, members, payments, emails, or public content. Confirm the target record before saving.",
    "If a provider or background job is involved, prefer retry/requeue controls over manual data edits.",
  ],
);

export const financeFallbackHelp = help(
  "Finance Help",
  "The finance workspace summarises booking, revenue, cost, and Xero-derived reporting data for operators with finance access.",
  [
    "Choose the reporting view and date windows, then apply the filters.",
    "Use CSV or PDF export for committee packs or offline reconciliation.",
    "Finance managers can run a manual sync when the sync status shows stale or missing data.",
  ],
  [
    {
      name: "View",
      description:
        "Switches between revenue, costs, bookings, balance sheet, and related finance lenses.",
    },
    {
      name: "Range",
      description:
        "Sets the main reporting period. Custom dates override the preset range.",
    },
    {
      name: "Compare",
      description:
        "Chooses the comparison window used by trend cards and variance summaries.",
    },
    {
      name: "Forward",
      description:
        "Adds a future-looking window for expected booking or revenue signals.",
    },
  ],
  [
    "Money values are shown from stored integer cents and mapped finance snapshots; this page does not move money.",
    "Xero data depends on the latest successful finance sync and the report mapping configuration in Admin > Setup.",
  ],
);

export const ADMIN_FALLBACK_QUESTIONS: HelpQuestion[] = [
  {
    q: "How do I find the right record?",
    a: "Use the page's search, filters, and tabs first so you are acting on the correct record set.",
  },
  {
    q: "How do I make a change safely?",
    a: "Open the record detail, dialog, or action button for the smallest change that completes the task, and read any validation or confirmation prompt before you save.",
  },
  {
    q: "What if a provider or background job is involved?",
    a: "Prefer the built-in retry or requeue controls over manual data edits.",
  },
];

export const FINANCE_FALLBACK_QUESTIONS: HelpQuestion[] = [
  {
    q: "How do I choose what the finance view shows?",
    a: "Pick the reporting view and date windows, then apply the filters.",
  },
  {
    q: "How do I export finance data?",
    a: "Use CSV or PDF export for committee packs or offline reconciliation.",
  },
  {
    q: "The data looks out of date — what can I do?",
    a: "Finance managers can run a manual sync when the sync status shows stale or missing data. The workspace does not move money itself.",
  },
];
