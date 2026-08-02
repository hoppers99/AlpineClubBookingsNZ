/**
 * AI Diagnostics — RESTRICTED record projections for page context (AID-4,
 * #2373).
 *
 * Each reader is a fixed, typed, parameterised read of ONE record by id, with an
 * explicit column allowlist. There is no dynamic column selection, no filter the
 * caller can influence beyond the id, and no model-authored query anywhere —
 * ADR-001 §2 forbids all three.
 *
 * THE OPT-IN SPLIT (ADR-004 §1) is structural, not conditional formatting: each
 * reader produces a `base` fact list that is non-identifying by construction
 * (states, counts, dates, integer cents) and an `identifying` list that is
 * produced ONLY when the operator opted this record in. When they did not, the
 * identifying fields are not merely hidden from the output — they are never
 * assembled, and the caller adds an explicit omission notice instead.
 *
 * REDACTION. Every free-text value passes `redactSensitiveText` and is then hard
 * -bounded, so an API key pasted into a booking note cannot ride out on the
 * evidence channel (ADR-004 §2).
 *
 * DATABASE ROLE. These reads currently run on the application's Prisma client.
 * ADR-007's dedicated SELECT-only role is the substrate AID-5 (#2374) builds;
 * when it lands, these readers move onto it. That is a defence-in-depth layer
 * beneath — never a substitute for — the fixed projections here and the fresh
 * `area:view` gate in `resolve.ts` (ADR-007 §2).
 */

import "server-only";

import { formatDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";

import {
  DIAGNOSTICS_PAGE_CONTEXT_BOUNDS,
  type DiagnosticsPageContextFact,
  type DiagnosticsRecordKind,
} from "./types";

/** `null` means "no such record" — distinct from "a record with no facts". */
export type RecordProjection = DiagnosticsPageContextFact[] | null;

export interface RecordProjectionInput {
  id: string;
  /** ADR-004 §1: true ONLY when the operator opted this specific record in. */
  includeSensitive: boolean;
}

function fact(key: string, value: string): DiagnosticsPageContextFact {
  return { key, value, sensitive: false };
}

/**
 * A fact carrying identifying/personal content. Redacted then hard-bounded —
 * truncation is marked so the model cannot read a cut-off value as a whole one.
 */
function sensitiveFact(
  key: string,
  value: string,
): DiagnosticsPageContextFact {
  const redacted = redactSensitiveText(value).trim();
  const max = DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.factValueMaxChars;
  return {
    key,
    value:
      redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted,
    sensitive: true,
  };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * Nights between two date-only lodge days. Both columns are `@db.Date`, so they
 * arrive as UTC midnight and the difference is exact whole days — no DST or
 * time-of-day term exists to round away.
 */
function nightsBetween(checkIn: Date, checkOut: Date): number {
  const days = Math.round(
    (checkOut.getTime() - checkIn.getTime()) / 86_400_000,
  );
  return days > 0 ? days : 0;
}

function displayName(person: {
  firstName: string;
  lastName: string;
}): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

async function readBooking({
  id,
  includeSensitive,
}: RecordProjectionInput): Promise<RecordProjection> {
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: {
      status: true,
      checkIn: true,
      checkOut: true,
      createdAt: true,
      deletedAt: true,
      requiresAdminReview: true,
      adminReviewStatus: true,
      notes: true,
      lodge: { select: { name: true } },
      member: { select: { firstName: true, lastName: true } },
      _count: { select: { guests: true } },
    },
  });
  if (!booking) return null;

  const facts: DiagnosticsPageContextFact[] = [
    fact("booking.status", booking.status),
    fact("booking.check-in", formatDateOnly(booking.checkIn)),
    fact("booking.check-out", formatDateOnly(booking.checkOut)),
    fact(
      "booking.nights",
      String(nightsBetween(booking.checkIn, booking.checkOut)),
    ),
    fact("booking.guest-count", String(booking._count.guests)),
    fact("booking.lodge", booking.lodge.name),
    fact("booking.deleted", yesNo(booking.deletedAt !== null)),
    fact("booking.requires-admin-review", yesNo(booking.requiresAdminReview)),
    fact("booking.created-at", booking.createdAt.toISOString()),
  ];
  if (booking.adminReviewStatus) {
    facts.push(fact("booking.admin-review-status", booking.adminReviewStatus));
  }

  if (includeSensitive) {
    facts.push(sensitiveFact("booking.member-name", displayName(booking.member)));
    if (booking.notes) {
      facts.push(sensitiveFact("booking.notes", booking.notes));
    }
  }

  return facts;
}

async function readMember({
  id,
  includeSensitive,
}: RecordProjectionInput): Promise<RecordProjection> {
  const member = await prisma.member.findUnique({
    where: { id },
    select: {
      active: true,
      canLogin: true,
      emailVerified: true,
      ageTier: true,
      createdAt: true,
      firstName: true,
      lastName: true,
    },
  });
  if (!member) return null;

  const facts: DiagnosticsPageContextFact[] = [
    fact("member.active", yesNo(member.active)),
    fact("member.can-login", yesNo(member.canLogin)),
    fact("member.email-verified", yesNo(member.emailVerified)),
    fact("member.age-tier", member.ageTier),
    fact("member.created-at", member.createdAt.toISOString()),
  ];

  // Contact details (email, phone, addresses) are deliberately NOT projected at
  // any opt-in level: nothing a page-context question needs turns on them, and
  // ADR-004 §2 asks for the minimum that answers the question. A membership tool
  // (AID-6B, #2376) is where a genuine contact-detail question belongs.
  if (includeSensitive) {
    facts.push(sensitiveFact("member.name", displayName(member)));
  }

  return facts;
}

async function readPayment({
  id,
  includeSensitive,
}: RecordProjectionInput): Promise<RecordProjection> {
  const payment = await prisma.payment.findUnique({
    where: { id },
    select: {
      status: true,
      source: true,
      amountCents: true,
      refundedAmountCents: true,
      creditAppliedCents: true,
      createdAt: true,
      booking: {
        select: { member: { select: { firstName: true, lastName: true } } },
      },
    },
  });
  if (!payment) return null;

  // Money stays integer cents end to end; the unit is in the fact KEY so the
  // model can never read a cent value as dollars.
  const facts: DiagnosticsPageContextFact[] = [
    fact("payment.status", payment.status),
    fact("payment.source", payment.source),
    fact("payment.amount-cents", String(payment.amountCents)),
    fact("payment.refunded-cents", String(payment.refundedAmountCents)),
    fact("payment.credit-applied-cents", String(payment.creditAppliedCents)),
    fact("payment.created-at", payment.createdAt.toISOString()),
  ];

  if (includeSensitive) {
    facts.push(
      sensitiveFact("payment.payer-name", displayName(payment.booking.member)),
    );
  }

  return facts;
}

const READERS: Record<
  DiagnosticsRecordKind,
  (input: RecordProjectionInput) => Promise<RecordProjection>
> = {
  booking: readBooking,
  member: readMember,
  payment: readPayment,
};

/**
 * Read the restricted projection for one record. The KIND comes from the
 * registry (server-owned), never from the client — which is what makes an
 * id-substitution attempt inert: a member id supplied on a booking page can only
 * fail to find a booking, it can never resolve a member.
 */
export function readRecordProjection(
  kind: DiagnosticsRecordKind,
  input: RecordProjectionInput,
): Promise<RecordProjection> {
  return READERS[kind](input);
}
