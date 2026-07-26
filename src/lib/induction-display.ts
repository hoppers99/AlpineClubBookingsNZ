// Client-safe types and label maps for the induction UI. Kept free of
// server-only code and the heavy default-template data so it can be imported by
// client components. API responses serialise dates to strings, so the client
// shapes below use string dates.

import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";

export type InductionStatus = "DRAFT" | "IN_PROGRESS" | "COMPLETED" | "VOIDED";
export type InductionKind =
  | "NEW_MEMBER"
  | "HUT_LEADER"
  | "YOUTH_TO_FULL"
  | "RE_INDUCTION";
export type InductionSignerRole = "NOMINATOR" | "HUT_LEADER" | "ADMIN";
export type InductionSectionPriority =
  | "EMERGENCY"
  | "SECURITY"
  | "STARTUP"
  | "SHUTDOWN"
  | "GENERAL";

export const INDUCTION_STATUS_LABELS: Record<InductionStatus, string> = {
  DRAFT: "Draft",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  VOIDED: "Voided",
};

export const INDUCTION_KIND_LABELS: Record<InductionKind, string> = {
  NEW_MEMBER: "New member",
  HUT_LEADER: "Hut Leader Induction",
  YOUTH_TO_FULL: "Youth → full member",
  RE_INDUCTION: "Re-induction",
};

export const INDUCTION_SIGNER_ROLE_LABELS: Record<InductionSignerRole, string> = {
  NOMINATOR: "Nominator",
  HUT_LEADER: "Hut leader",
  ADMIN: "Administrator",
};

interface InductionItemClient {
  id: string;
  label: string;
  competencyPrompt: string | null;
  notesPrompt: string | null;
  isMandatory: boolean;
  requiresDemonstration: boolean;
}

interface InductionSectionClient {
  id: string;
  title: string;
  description: string | null;
  priority: InductionSectionPriority;
  items: InductionItemClient[];
}

interface InductionSignOffClient {
  id: string;
  signerMemberId: string | null;
  signerName: string;
  signerRole: InductionSignerRole;
  comments: string | null;
  signedAt: string;
}

interface AssignedSignerClient {
  memberId: string;
  firstName: string;
  lastName: string;
  emailSentAt: string | null;
}

export interface InductionDetailClient {
  id: string;
  kind: InductionKind;
  status: InductionStatus;
  requiredSignOffs: number;
  inductionDate: string | null;
  completedAt: string | null;
  finalComments: string | null;
  member: { id: string; firstName: string; lastName: string };
  template: {
    id: string;
    name: string;
    version: string;
    kind: InductionKind;
    sections: InductionSectionClient[];
  };
  signOffs: InductionSignOffClient[];
  assignedSigners: AssignedSignerClient[];
}

export interface AwaitingInductionClient {
  id: string;
  kind: InductionKind;
  createdAt: string;
  requiredSignOffs: number;
  signOffCount: number;
  member: { firstName: string; lastName: string };
}

// #2256: this used to call `toLocaleDateString("en-NZ", { dateStyle: "long" })`
// with no `timeZone`, so it rendered in the *runtime's* zone — the browser's for
// the member/admin induction screens, the server's for the print page. An
// induction sign-off timestamped 2026-04-15T23:30Z is 16 April in New Zealand
// but 15 April in UTC, so the signed-on date on a legal-ish record could differ
// per viewer. The zone (and locale) now come from the app config, exactly like
// formatNZDate. The "long" style is deliberate on these records and is kept.
const INDUCTION_DATE_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  dateStyle: "long",
});

export function formatInductionDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  // Intl throws RangeError on an invalid Date, so guard rather than crash a
  // client component on a malformed API value.
  if (Number.isNaN(parsed.getTime())) return null;
  return INDUCTION_DATE_FORMATTER.format(parsed);
}
