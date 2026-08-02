import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: mocks.sendEmail,
}));

import { EMAIL_AUDIT_DEFAULTS } from "@/lib/email-message-audit-defaults";
import { renderTemplateString } from "@/lib/email-message-renderer";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";
import { ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES } from "@/lib/booking-email-suppression";
import { BOOKING_URL_TEMPLATE_NAMES } from "@/lib/booking-email-template-contract";
import { wholeLodgeGuestNamesUrgencyNote } from "@/lib/email-message-notes";
import { sendWholeLodgeGuestNamesReminderEmail } from "@/lib/email/booking";

const TEMPLATE = "whole-lodge-guest-names-reminder";

async function send(stage: "first" | "reminder" | "final") {
  await sendWholeLodgeGuestNamesReminderEmail({
    bookingId: "booking-wl-1",
    recipientMemberId: "m-1",
    email: "member@example.org",
    firstName: "Mere",
    checkIn: new Date("2026-08-11T00:00:00.000Z"),
    checkOut: new Date("2026-08-13T00:00:00.000Z"),
    guestCount: 6,
    unnamedGuestCount: 4,
    stage,
    lodgeId: "lodge-1",
  });
  expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  return mocks.sendEmail.mock.calls[0][0] as {
    subject: string;
    html: string;
    templateName: string;
    templateData: Record<string, string | number>;
    bookingContext: unknown;
    lodgeId?: string | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendEmail.mockResolvedValue(undefined);
});

describe("whole-lodge guest-name reminder email (#2550)", () => {
  it("is registered as a member-facing, booking-scoped template", () => {
    const definition = getEmailTemplateDefinition(TEMPLATE);

    expect(definition?.audience).toBe("member");
    expect(definition?.requiredTokens).toEqual([
      "unnamedGuestCount",
      "namingUrgencyNote",
    ]);
    expect(ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(TEMPLATE)).toBe(true);
    expect(BOOKING_URL_TEMPLATE_NAMES.has(TEMPLATE)).toBe(true);
  });

  it("carries no bearer token, so the member reaches the booking behind their login", () => {
    const definition = getEmailTemplateDefinition(TEMPLATE);

    expect(definition?.allowedTokens).not.toContain("token");
    expect(EMAIL_AUDIT_DEFAULTS[TEMPLATE].defaultBody).not.toContain("{{token}}");
    // The canonical authorized detail link is appended centrally.
    expect(EMAIL_AUDIT_DEFAULTS[TEMPLATE].defaultBody).toContain(
      "{{bookingUrl}}",
    );
  });

  it("supplies every token its shipped default body renders", async () => {
    const call = await send("first");
    const rendered = renderTemplateString(
      EMAIL_AUDIT_DEFAULTS[TEMPLATE].defaultBody,
      { ...call.templateData, bookingUrl: "https://example.org/bookings/b1" },
    );

    expect(call.templateName).toBe(TEMPLATE);
    expect(rendered).toContain("Still unnamed: 4");
    expect(rendered).toContain("Guests: 6");
    expect(rendered).toContain(wholeLodgeGuestNamesUrgencyNote("first"));
    // Nothing may render as a dangling label.
    expect(rendered).not.toMatch(/^\s*\w[\w ]*:\s*$/m);
  });

  it("hands the SAME composed urgency sentence to the HTML and the flat body", async () => {
    for (const stage of ["first", "reminder", "final"] as const) {
      mocks.sendEmail.mockClear();
      const call = await send(stage);
      const note = wholeLodgeGuestNamesUrgencyNote(stage);

      expect(call.templateData.namingUrgencyNote).toBe(note);
      // The HTML escapes the sentence, so compare on a distinctive fragment
      // that survives escaping.
      expect(call.html).toContain(note.slice(0, 40));
    }
  });

  it("escalates only the tone — never the consequence", () => {
    const final = wholeLodgeGuestNamesUrgencyNote("final");

    expect(final).toContain("come anyway");
    expect(final).toContain("confirmed either way");
    for (const stage of ["first", "reminder", "final"] as const) {
      const note = wholeLodgeGuestNamesUrgencyNote(stage);
      // No stage may threaten the stay: the owner decision is visibility only.
      expect(note).not.toMatch(
        /will be cancelled|cannot check in|will not be able|refused|held until/i,
      );
      expect(note.length).toBeGreaterThan(0);
      // No stage may assert a previous DELIVERY. The cadence stamp is claimed
      // before the send and kept when the send fails, so the "reminder" stage
      // proves an attempt, not an arrival: a member whose first reminder
      // bounced would otherwise be told the club had already asked them.
      expect(note).not.toMatch(
        /asked (?:you )?(?:about this )?(?:once )?already|previous(?:ly)? (?:email|reminder)|we (?:have )?emailed you/i,
      );
    }
  });

  it("previews the composed urgency sentence instead of the bare token name", () => {
    // The admin editor's preview is the only picture an admin has of what a
    // member reads. Left to the registry's fallthrough, a pre-composed token
    // previews as the literal word "namingUrgencyNote".
    const definition = getEmailTemplateDefinition(TEMPLATE);

    expect(definition?.sampleData.namingUrgencyNote).toBe(
      wholeLodgeGuestNamesUrgencyNote("first"),
    );
    expect(definition?.sampleData.namingUrgencyNote).not.toBe(
      "namingUrgencyNote",
    );
  });

  it("uses a last-chance subject only on the final stage", async () => {
    const first = await send("first");
    mocks.sendEmail.mockClear();
    const final = await send("final");

    expect(first.subject).toContain("Who is coming with you?");
    expect(final.subject).toContain("Last chance");
  });

  it("threads the booking owner context and the booking's lodge identity", async () => {
    const call = await send("first");

    expect(call.bookingContext).toMatchObject({ bookingId: "booking-wl-1" });
    expect(call.lodgeId).toBe("lodge-1");
  });
});
