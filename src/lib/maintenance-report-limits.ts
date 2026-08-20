/**
 * Bounded limits for the maintenance-report form (#2780).
 *
 * A CLIENT-SAFE MODULE ON PURPOSE. These are the numbers the bounded question
 * editor and the shared form need in the browser, and they must be importable
 * from a `"use client"` component without dragging the submit service — which
 * reaches `crypto`, Prisma and the settings/photo modules — into the browser
 * bundle (INV-OPS-013, the client/server boundary census). Pure literals, no
 * imports; the server service re-exports them so callers keep one import site.
 *
 * The editor and the write endpoint import the SAME numbers so the UI cannot
 * offer something the server will refuse (decision 2 on #2780: a bounded editor,
 * not a form builder).
 */

/** Question limits. */
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
