/**
 * The contextual-help registry: the public accessor surface, and the assembly
 * of the corpus behind it.
 *
 * #2689 split a 2,695-line file into one module per admin section, using the
 * sections the product already shows operators (`navSections` in
 * `admin-sidebar.tsx`). This module is NOT a compatibility barrel over that
 * split — it is the registry itself: it owns the path matching, the
 * longest-prefix resolution, the fallbacks, and the question attachment. The
 * three functions it exports are the same three that were public before.
 *
 * Callers that want only a TYPE take `./types`, and callers that want only the
 * booking-status glossary take `./booking-status-glossary`; neither pulls the
 * corpus in.
 */
import { adminDashboardHelpEntries } from "./admin/dashboard";
import { adminBookingsAndBedsHelpEntries } from "./admin/bookings-and-beds";
import { adminMembersHelpEntries } from "./admin/members";
import { adminFinanceHelpEntries } from "./admin/finance";
import { adminMonitoringAndSupportHelpEntries } from "./admin/monitoring-and-support";
import { adminLodgeOperationsHelpEntries } from "./admin/lodge-operations";
import { adminRatesAndPoliciesHelpEntries } from "./admin/rates-and-policies";
import { adminSetupAndConfigurationHelpEntries } from "./admin/setup-and-configuration";
import { adminAppearanceAndWebsiteHelpEntries } from "./admin/appearance-and-website";
import {
  ADMIN_FALLBACK_QUESTIONS,
  adminFallbackHelp,
  FINANCE_FALLBACK_QUESTIONS,
  financeFallbackHelp,
} from "./fallbacks";
import { financeHelpEntries } from "./finance";
import { ADMIN_HELP_QUESTIONS } from "./questions-admin";
import { FINANCE_HELP_QUESTIONS } from "./questions-finance";
import type { ContextualHelpContent, HelpEntry, HelpScope } from "./types";

/**
 * Every admin page's help, in one list for lookup.
 *
 * ORDER. `getContextualHelp` picks the LONGEST matching path, so the order of
 * this array decides nothing except among entries whose paths are the same
 * length — and the modules preserve the original relative order within a
 * section, which is what keeps the one duplicated path resolving to the same
 * entry it always did.
 */
const adminHelpEntries: HelpEntry[] = [
  ...adminDashboardHelpEntries,
  ...adminBookingsAndBedsHelpEntries,
  ...adminMembersHelpEntries,
  ...adminFinanceHelpEntries,
  ...adminMonitoringAndSupportHelpEntries,
  ...adminLodgeOperationsHelpEntries,
  ...adminRatesAndPoliciesHelpEntries,
  ...adminSetupAndConfigurationHelpEntries,
  ...adminAppearanceAndWebsiteHelpEntries,
];

for (const candidate of adminHelpEntries) {
  const questions = ADMIN_HELP_QUESTIONS[candidate.path];
  if (questions) {
    candidate.content.questions = questions;
  }
}

for (const candidate of financeHelpEntries) {
  const questions = FINANCE_HELP_QUESTIONS[candidate.path];
  if (questions) {
    candidate.content.questions = questions;
  }
}

adminFallbackHelp.questions = ADMIN_FALLBACK_QUESTIONS;
financeFallbackHelp.questions = FINANCE_FALLBACK_QUESTIONS;

export function normalisePath(pathname: string | null | undefined) {
  if (!pathname) {
    return "/";
  }
  const withoutQuery = pathname.split(/[?#]/, 1)[0] || "/";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

function isPathMatch(pathname: string, entryPath: string) {
  return pathname === entryPath || pathname.startsWith(`${entryPath}/`);
}

export function getContextualHelp(
  pathname: string | null | undefined,
  scope: HelpScope,
): ContextualHelpContent {
  const path = normalisePath(pathname);
  const entries = scope === "admin" ? adminHelpEntries : financeHelpEntries;
  const fallback = scope === "admin" ? adminFallbackHelp : financeFallbackHelp;

  return (
    entries
      .filter((candidate) => isPathMatch(path, candidate.path))
      .sort((a, b) => b.path.length - a.path.length)[0]?.content ?? fallback
  );
}

// test seam
export function getContextualHelpPaths(scope: HelpScope): string[] {
  return (scope === "admin" ? adminHelpEntries : financeHelpEntries).map(
    (candidate) => candidate.path,
  );
}
