import type {
  MaintenanceQuestionType,
  MaintenanceReportSource,
  Prisma,
} from "@prisma/client";
import { createHash } from "crypto";

import { prisma } from "@/lib/prisma";
import {
  getMaintenancePhotoExpiresAt,
  type MaintenanceReportSettingsValues,
} from "@/lib/maintenance-report-settings";
import {
  parseMaintenancePhoto,
  MaintenancePhotoError,
} from "@/lib/maintenance-report-photo";

/**
 * The shared maintenance-report service (#2780).
 *
 * ONE SUBMIT PATH, TWO DOORS. The members' portal card and the unauthenticated
 * QR form both land in `createMaintenanceReport` below, so the question set, the
 * answer validation, the photo rules and the answers-as-asked snapshot cannot
 * drift between them. What the two doors do NOT share is authorisation, rate
 * limiting or what they are allowed to send — those live in the routes, which is
 * the only place they should, because they are the difference between the doors.
 *
 * WHAT AN ANONYMOUS SUBMITTER MAY SEND is enforced here as well as at the route,
 * by construction rather than by a check: `memberId` is not a field the QR route
 * can reach (see `AnonymousSubmission`), so no anonymous submission can name a
 * member however it is shaped.
 */

/** Question limits. Bounded editor, not a form builder — decision 2 on #2780. */
export const MAX_MAINTENANCE_QUESTIONS = 20;
export const MAX_MAINTENANCE_QUESTION_LABEL_LENGTH = 200;
export const MAX_MAINTENANCE_QUESTION_HELP_LENGTH = 300;
export const MAX_MAINTENANCE_QUESTION_CHOICES = 10;
export const MAX_MAINTENANCE_QUESTION_CHOICE_LENGTH = 120;

/** Answer limits, applied to every submission on both paths. */
export const MAX_MAINTENANCE_SUMMARY_LENGTH = 200;
export const MAX_MAINTENANCE_SHORT_ANSWER_LENGTH = 300;
export const MAX_MAINTENANCE_LONG_ANSWER_LENGTH = 2000;
export const MAX_MAINTENANCE_REPORTER_NAME_LENGTH = 120;
export const MAX_MAINTENANCE_REPORTER_CONTACT_LENGTH = 200;

export class MaintenanceReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceReportValidationError";
  }
}

export type PublicMaintenanceQuestion = {
  id: string;
  label: string;
  helpText: string | null;
  type: MaintenanceQuestionType;
  required: boolean;
  choices: string[];
  sortOrder: number;
};

const PUBLIC_QUESTION_SELECT = {
  id: true,
  label: true,
  helpText: true,
  type: true,
  required: true,
  choices: true,
  sortOrder: true,
} satisfies Prisma.MaintenanceReportQuestionSelect;

/**
 * The question set a form should render: active questions in admin order.
 *
 * This is the ONLY thing the anonymous surface may read. It contains no member
 * data, no lodge data beyond the name the route already resolved from the token,
 * and no ids that mean anything elsewhere.
 */
export async function loadActiveMaintenanceQuestions(): Promise<
  PublicMaintenanceQuestion[]
> {
  return prisma.maintenanceReportQuestion.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: PUBLIC_QUESTION_SELECT,
    take: MAX_MAINTENANCE_QUESTIONS,
  });
}

export type SubmittedAnswer = {
  questionId: string;
  value: string;
};

/** The snapshot written beside each answer — decision 2 made structural. */
type AnswerRow = {
  questionId: string;
  questionLabel: string;
  questionType: MaintenanceQuestionType;
  sortOrder: number;
  answerText: string;
};

function maxLengthForType(type: MaintenanceQuestionType): number {
  switch (type) {
    case "LONG_TEXT":
      return MAX_MAINTENANCE_LONG_ANSWER_LENGTH;
    case "SHORT_TEXT":
      return MAX_MAINTENANCE_SHORT_ANSWER_LENGTH;
    case "YES_NO":
      return 3;
    case "SINGLE_CHOICE":
      return MAX_MAINTENANCE_QUESTION_CHOICE_LENGTH;
  }
}

/**
 * Validate the submitted answers against the question set, and produce the rows
 * to store.
 *
 * THE QUESTION SET IS AUTHORITATIVE, NOT THE SUBMISSION. The result is built by
 * walking `questions` and looking each one up in what was sent — never the other
 * way round — so an answer naming a question that is inactive, deleted, or was
 * never in the set is DISCARDED rather than stored. That is what stops the form
 * being used to write arbitrary text into the officer's queue under a
 * question-shaped label of the sender's choosing.
 */
export function buildMaintenanceAnswerRows(
  questions: PublicMaintenanceQuestion[],
  submitted: SubmittedAnswer[],
): AnswerRow[] {
  const byId = new Map<string, string>();
  for (const answer of submitted) {
    // Last write wins on a duplicated question id; the alternative (refusing)
    // turns a double-submitted form field into an error a reporter cannot act on.
    byId.set(answer.questionId, answer.value);
  }

  const rows: AnswerRow[] = [];

  for (const question of questions) {
    const raw = (byId.get(question.id) ?? "").trim();

    if (!raw) {
      if (question.required) {
        throw new MaintenanceReportValidationError(
          `Please answer: ${question.label}`,
        );
      }
      // An unanswered optional question stores no row at all, so the admin view
      // shows what was asked and answered rather than a wall of blanks.
      continue;
    }

    if (raw.length > maxLengthForType(question.type)) {
      throw new MaintenanceReportValidationError(
        `That answer is too long: ${question.label}`,
      );
    }

    let value = raw;

    if (question.type === "YES_NO") {
      const normalised = raw.toLowerCase();
      if (normalised !== "yes" && normalised !== "no") {
        throw new MaintenanceReportValidationError(
          `Please answer yes or no: ${question.label}`,
        );
      }
      value = normalised === "yes" ? "Yes" : "No";
    }

    if (question.type === "SINGLE_CHOICE") {
      // The stored value must be one the admin configured. Storing free text
      // here would let a submitter invent an urgency level that no filter,
      // report or triage rule knows about.
      const match = question.choices.find((choice) => choice === raw);
      if (!match) {
        throw new MaintenanceReportValidationError(
          `Please choose one of the options for: ${question.label}`,
        );
      }
      value = match;
    }

    rows.push({
      questionId: question.id,
      questionLabel: question.label,
      questionType: question.type,
      sortOrder: question.sortOrder,
      answerText: value,
    });
  }

  return rows;
}

/**
 * A one-way fingerprint of the submitting address, for the anonymous path only.
 *
 * WHY A HASH RATHER THAN THE ADDRESS. Its only job is "were these submissions
 * from the same source", which equality answers without keeping anything that
 * identifies a person or a household. It is also given its own expiry and swept
 * by the retention cron, so the answer stops being available at the same time
 * the photo does.
 */
export function fingerprintSubmitter(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

type BaseSubmission = {
  lodgeId: string;
  summary: string;
  answers: SubmittedAnswer[];
  photoDataUrl?: string | null;
};

export type MemberSubmission = BaseSubmission & {
  source: Extract<MaintenanceReportSource, "MEMBER_PORTAL">;
  memberId: string;
};

/**
 * The anonymous shape. Note there is NO `memberId` here, and that is the
 * enforcement rather than a comment about one: the QR route cannot pass a member
 * id because the type it constructs has no field to put one in.
 */
export type AnonymousSubmission = BaseSubmission & {
  source: Extract<MaintenanceReportSource, "LODGE_QR">;
  reporterName?: string | null;
  reporterContact?: string | null;
  submitterIp: string;
};

export type MaintenanceSubmission = MemberSubmission | AnonymousSubmission;

function trimToNull(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export type CreatedMaintenanceReport = {
  id: string;
  answerCount: number;
  hasPhoto: boolean;
};

/**
 * Create one report with its answers, in a single transaction.
 *
 * The transaction is deliberately narrow — two writes on tables nothing else
 * contends for — and does NO provider work: the officer alert is sent by the
 * caller, after the transaction commits, so a slow mail server can never hold a
 * database transaction open (AGENTS.md, change discipline).
 *
 * There is no lock here and none is needed. A maintenance report claims no
 * capacity, moves no money and transitions no lifecycle, so two concurrent
 * submissions are two independent inserts. That is why this file registers no
 * advisory-lock site.
 */
export async function createMaintenanceReport(
  submission: MaintenanceSubmission,
  settings: MaintenanceReportSettingsValues,
  questions: PublicMaintenanceQuestion[],
  now: Date = new Date(),
): Promise<CreatedMaintenanceReport> {
  const summary = submission.summary.trim();
  if (!summary) {
    throw new MaintenanceReportValidationError(
      "Please say briefly what needs fixing.",
    );
  }
  if (summary.length > MAX_MAINTENANCE_SUMMARY_LENGTH) {
    throw new MaintenanceReportValidationError(
      "That summary is too long. Please keep it under 200 characters.",
    );
  }

  const answerRows = buildMaintenanceAnswerRows(questions, submission.answers);

  const anonymous = submission.source === "LODGE_QR";

  // Photos are refused where the club has switched them off, on the specific
  // path they switched off. A payload arriving with one anyway is an ERROR
  // rather than a silent drop, so a reporter is never told their photo was
  // received when it was thrown away.
  const photosAllowed = anonymous
    ? settings.photosEnabled && settings.anonymousPhotosEnabled
    : settings.photosEnabled;

  if (submission.photoDataUrl && !photosAllowed) {
    throw new MaintenanceReportValidationError(
      "Photos are not being accepted at the moment. Please describe the problem instead.",
    );
  }

  let photo: ReturnType<typeof parseMaintenancePhoto> = null;
  try {
    photo = photosAllowed ? parseMaintenancePhoto(submission.photoDataUrl) : null;
  } catch (err) {
    if (err instanceof MaintenancePhotoError) {
      throw new MaintenanceReportValidationError(err.message);
    }
    throw err;
  }

  const expiresAt = getMaintenancePhotoExpiresAt(settings.photoRetentionDays, now);

  const report = await prisma.$transaction(async (tx) => {
    const created = await tx.maintenanceReport.create({
      data: {
        lodgeId: submission.lodgeId,
        source: submission.source,
        summary,
        memberId: anonymous ? null : submission.memberId,
        reporterName: anonymous
          ? trimToNull(submission.reporterName, MAX_MAINTENANCE_REPORTER_NAME_LENGTH)
          : null,
        reporterContact: anonymous
          ? trimToNull(
              submission.reporterContact,
              MAX_MAINTENANCE_REPORTER_CONTACT_LENGTH,
            )
          : null,
        photoDataUrl: photo?.dataUrl ?? null,
        photoContentType: photo?.contentType ?? null,
        photoCapturedAt: photo ? now : null,
        photoExpiresAt: photo ? expiresAt : null,
        // The fingerprint exists only where there is no account behind the
        // submission. A signed-in member is already identified by `memberId`,
        // so keeping their address as well would be data collected for nothing.
        submitterIpHash: anonymous ? fingerprintSubmitter(submission.submitterIp) : null,
        submitterIpHashExpiresAt: anonymous ? expiresAt : null,
      },
      select: { id: true },
    });

    if (answerRows.length > 0) {
      await tx.maintenanceReportAnswer.createMany({
        data: answerRows.map((row) => ({ ...row, reportId: created.id })),
      });
    }

    return created;
  });

  return {
    id: report.id,
    answerCount: answerRows.length,
    hasPhoto: Boolean(photo),
  };
}
