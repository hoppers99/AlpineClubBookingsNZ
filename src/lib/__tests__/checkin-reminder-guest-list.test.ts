import { describe, it, expect, vi, beforeEach } from "vitest";

// #2307 — the check-in reminder's guest list.
//
// The delivered HTML has always rendered one <li> per guest, but the audited /
// operator-overridable body did not: the sender supplied every FIRST name
// comma-joined into {{guestFirstName}} and every LAST name comma-joined into
// {{guestLastName}}, on one line, so a real three-guest booking rendered
//
//   Ada, Bob, Cleo Lovelace, Smith, Jones
//
// with every surname attached to the wrong person. An admin who switched this
// template to an override was sending that to members, and the EmailLog audit
// recorded it for every send whether overridden or not.
//
// This pins the fix from both ends: what the sender puts in templateData, and
// what the registry's default body renders from it. The two have to agree or the
// bug simply moves.
//
// Harness mirrors booking-confirmed-split-email.test.ts (#1942), which pins the
// same kind of sender-to-token wiring.

const { sendEmailMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  // Search key the email <title> bakes (C6 #1985); required alongside
  // EMAIL_DEFAULT_LODGE_NAME whenever this module is mocked and a template
  // renders.
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: vi.fn().mockResolvedValue({
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: null,
  }),
}));

const CHECK_IN = new Date("2026-07-15");
const CHECK_OUT = new Date("2026-07-18");

const GUESTS = [
  { firstName: "Ada", lastName: "Lovelace" },
  { firstName: "Bob", lastName: "Smith" },
  { firstName: "Cleo", lastName: "Jones" },
];

describe("check-in reminder guest list (#2307)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives each guest their own first AND last name, one per line", async () => {
    const { sendCheckinReminderEmail } = await import("../email/booking");

    await sendCheckinReminderEmail(
      { bookingId: "bk_test" },
      "member@example.org",
      "Sam",
      CHECK_IN,
      CHECK_OUT,
      GUESTS,
      [],
    );

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.templateName).toBe("checkin-reminder");
    expect(call.templateData.guestName).toBe(
      "Ada Lovelace\nBob Smith\nCleo Jones",
    );

    // The bug, stated so it cannot come back quietly: no surname may ever end up
    // on a line of its own, and the two split tokens are gone entirely.
    expect(call.templateData.guestName).not.toContain("Ada, Bob");
    expect(call.templateData).not.toHaveProperty("guestFirstName");
    expect(call.templateData).not.toHaveProperty("guestLastName");
    expect(call.templateData.guestCount).toBe(3);
  });

  it("still renders one list item per guest in the delivered HTML", async () => {
    // Unchanged behaviour, asserted because this fix must not touch what members
    // actually receive — only what the audit and an override render.
    const { sendCheckinReminderEmail } = await import("../email/booking");

    await sendCheckinReminderEmail(
      { bookingId: "bk_test" },
      "member@example.org",
      "Sam",
      CHECK_IN,
      CHECK_OUT,
      GUESTS,
      [],
    );

    const { html } = sendEmailMock.mock.calls[0][0];
    for (const guest of GUESTS) {
      expect(html).toContain(`${guest.firstName} ${guest.lastName}`);
    }
    expect(html).not.toContain("Ada, Bob");
  });

  it("copes with a single guest and with an empty guest list", async () => {
    const { sendCheckinReminderEmail } = await import("../email/booking");

    await sendCheckinReminderEmail(
      { bookingId: "bk_test" },
      "member@example.org",
      "Sam",
      CHECK_IN,
      CHECK_OUT,
      [GUESTS[0]],
      [],
    );
    expect(sendEmailMock.mock.calls[0][0].templateData.guestName).toBe(
      "Ada Lovelace",
    );

    sendEmailMock.mockClear();
    await sendCheckinReminderEmail(
      { bookingId: "bk_test" },
      "member@example.org",
      "Sam",
      CHECK_IN,
      CHECK_OUT,
      [],
      [],
    );
    expect(sendEmailMock.mock.calls[0][0].templateData.guestName).toBe("");
    expect(sendEmailMock.mock.calls[0][0].templateData.guestCount).toBe(0);
  });

  it("renders the registry default body as one guest per line", async () => {
    // The override render path: prepareEmailMessage feeds a stored bodyText
    // through renderTemplateString with the send's templateData. Proving the
    // DEFAULT body renders correctly from the sender's own data is what makes
    // the sender and the registry agree — a fix to only one of them would leave
    // either "{{guestName}}" unresolved or the names still mis-joined.
    const { sendCheckinReminderEmail } = await import("../email/booking");
    await sendCheckinReminderEmail(
      { bookingId: "bk_test" },
      "member@example.org",
      "Sam",
      CHECK_IN,
      CHECK_OUT,
      GUESTS,
      [],
    );
    const { templateData } = sendEmailMock.mock.calls[0][0];

    const { getEmailTemplateDefinition } = await import(
      "../email-message-registry"
    );
    const { renderTemplateString } = await import("../email-message-renderer");
    const definition = getEmailTemplateDefinition("checkin-reminder");
    if (!definition) throw new Error("missing checkin-reminder definition");

    const rendered = renderTemplateString(definition.defaultBody, templateData);

    expect(rendered).toContain("Guest list:\n\nAda Lovelace\nBob Smith\nCleo Jones");
    // Nothing left unresolved in the guest-list region, and no trace of the old
    // pair of tokens.
    expect(rendered).not.toContain("{{guestName}}");
    expect(definition.defaultBody).not.toContain("{{guestFirstName}}");
    expect(definition.defaultBody).not.toContain("{{guestLastName}}");
  });

  it("uses the already-approved guestName token, adding none of its own", async () => {
    // Deliberate constraint (#2307): a sibling lane is adding new template keys
    // to email-message-registry.ts and email-message-audit-defaults.ts, so this
    // fix registers nothing. guestName was already approved, and each template's
    // allowedTokens/sampleData are derived from its default body, so the registry
    // needed no edit at all.
    const { APPROVED_EMAIL_TEMPLATE_TOKEN_SET } = await import(
      "../email-message-registry"
    );
    expect(APPROVED_EMAIL_TEMPLATE_TOKEN_SET.has("guestName")).toBe(true);

    const { getEmailTemplateDefinition } = await import(
      "../email-message-registry"
    );
    const definition = getEmailTemplateDefinition("checkin-reminder");
    expect(definition?.allowedTokens).toContain("guestName");
  });
});
