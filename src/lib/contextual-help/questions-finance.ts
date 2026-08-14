/**
 * The curated question chips for the finance workspace.
 */
import type { HelpQuestion } from "./types";

export const FINANCE_HELP_QUESTIONS: Record<string, HelpQuestion[]> = {
  "/finance": [
    {
      q: "What does the Finance dashboard show?",
      a: "Booking metrics, revenue and cost views, mapped Xero snapshots, sync diagnostics, and export tools.",
    },
    {
      q: "How do I change the reporting period?",
      a: "Set the view, date range, comparison range, and forward window, then apply the filters.",
    },
    {
      q: "How do I export for a committee pack?",
      a: "Use the CSV or PDF export. Exports reflect the currently applied filters.",
    },
    {
      q: "The finance data looks stale — what do I do?",
      a: "If you are a finance manager, run a manual sync. The dashboard depends on the latest successful finance sync and the Admin > Setup finance mappings.",
    },
    {
      q: "Does this page move money?",
      a: "No. It reads mapped Xero snapshots and stored integer-cent figures for reporting only.",
    },
  ],
};
