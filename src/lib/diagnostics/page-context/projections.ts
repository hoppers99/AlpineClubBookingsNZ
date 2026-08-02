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
 * REDACTION AND BOUNDS. EVERY value, sensitive or not, is hard-bounded, and
 * every free-text value also passes `redactSensitiveText` first — so an API key
 * pasted into a booking note cannot ride out on the evidence channel (ADR-004
 * §2), and an unbounded admin-editable column (a lodge name is a plain `String`)
 * cannot swell the projection until the rendered evidence has to be truncated.
 * There are exactly three constructors and no fourth way to add a fact:
 * `derivedFact` (closed-vocabulary server values), `textFact` (non-identifying
 * free text) and `sensitiveFact` (identifying free text, opt-in only).
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

/**
 * The ONE path every free-text value takes: redact, then hard-bound. Truncation
 * is marked so the model cannot read a cut-off value as a whole one.
 */
function boundedRedacted(value: string): string {
  const redacted = redactSensitiveText(value).trim();
  const max = DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.factValueMaxChars;
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/**
 * The shape a server-DERIVED value may have: a Prisma enum token, `yes`/`no`, a
 * count, an integer-cents amount, an NZ date-only day, or an ISO instant. Short
 * and punctuation-poor by construction, so it is already bounded and carries no
 * free text to redact.
 */
const DERIVED_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.:+-]{0,63}$/;

/**
 * A fact whose value comes from a CLOSED vocabulary the server owns (enum,
 * boolean, count, integer cents, date). Deliberately not passed through
 * `redactSensitiveText`: its phone-like digit-run heuristic would rewrite an
 * eight-digit integer-cents amount to `[REDACTED]`, corrupting money.
 *
 * The shape is therefore VERIFIED rather than trusted. A value that is not
 * closed-vocabulary shaped — i.e. someone used this constructor for a free-text
 * column — falls back to the redact-and-bound path instead of travelling raw, so
 * the failure mode of that mistake is a redacted fact, never an unbounded one.
 */
function derivedFact(key: string, value: string): DiagnosticsPageContextFact {
  return {
    key,
    value: DERIVED_VALUE_PATTERN.test(value) ? value : boundedRedacted(value),
    sensitive: false,
  };
}

/**
 * A NON-identifying free-text column (a lodge name). Redacted and bounded on the
 * same path as a sensitive fact — the opt-in split governs WHICH fields are
 * assembled, never whether a free-text value is cleaned up.
 */
function textFact(key: string, value: string): DiagnosticsPageContextFact {
  return { key, value: boundedRedacted(value), sensitive: false };
}

/** A fact carrying identifying/personal content. Redacted then hard-bounded. */
function sensitiveFact(
  key: string,
  value: string,
): DiagnosticsPageContextFact {
  return { key, value: boundedRedacted(value), sensitive: true };
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
    derivedFact("booking.status", booking.status),
    derivedFact("booking.check-in", formatDateOnly(booking.checkIn)),
    derivedFact("booking.check-out", formatDateOnly(booking.checkOut)),
    derivedFact(
      "booking.nights",
      String(nightsBetween(booking.checkIn, booking.checkOut)),
    ),
    derivedFact("booking.guest-count", String(booking._count.guests)),
    // `Lodge.name` is a plain `String` an admin types, so it is free text even
    // though it identifies nobody.
    textFact("booking.lodge", booking.lodge.name),
    derivedFact("booking.deleted", yesNo(booking.deletedAt !== null)),
    derivedFact(
      "booking.requires-admin-review",
      yesNo(booking.requiresAdminReview),
    ),
    derivedFact("booking.created-at", booking.createdAt.toISOString()),
  ];
  if (booking.adminReviewStatus) {
    facts.push(
      derivedFact("booking.admin-review-status", booking.adminReviewStatus),
    );
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
    derivedFact("member.active", yesNo(member.active)),
    derivedFact("member.can-login", yesNo(member.canLogin)),
    derivedFact("member.email-verified", yesNo(member.emailVerified)),
    derivedFact("member.age-tier", member.ageTier),
    derivedFact("member.created-at", member.createdAt.toISOString()),
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
    derivedFact("payment.status", payment.status),
    derivedFact("payment.source", payment.source),
    derivedFact("payment.amount-cents", String(payment.amountCents)),
    derivedFact("payment.refunded-cents", String(payment.refundedAmountCents)),
    derivedFact(
      "payment.credit-applied-cents",
      String(payment.creditAppliedCents),
    ),
    derivedFact("payment.created-at", payment.createdAt.toISOString()),
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
