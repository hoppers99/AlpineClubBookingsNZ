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
    // on a line of its own, and neither legacy token may ever again carry a
    // comma-joined list of one name part.
    expect(call.templateData.guestName).not.toContain("Ada, Bob");
    expect(call.templateData.guestFirstName).not.toContain("Ada, Bob");
    expect(call.templateData.guestLastName).not.toContain("Lovelace, Smith");
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

  // --- back-compatibility for a body saved BEFORE the fix ------------------
  //
  // Nothing rewrites a club's stored override, so any club that had customised
  // this message still holds the old "{{guestFirstName}} {{guestLastName}}"
  // pair. renderTemplateString substitutes an unsupplied token with an empty
  // string, so had the fix simply dropped the pair, those clubs would have
  // started sending a check-in reminder that names NOBODY — a worse failure
  // than the misattribution it replaced, and a silent one.

  it("still names every guest in a body saved with the OLD pair of tokens", async () => {
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

    const { renderTemplateString } = await import("../email-message-renderer");
    // The pre-fix default body, verbatim, which is what a club's saved override
    // was customised from.
    const savedOverrideBody =
      "Check-in Reminder\n\nHi {{firstName}}, your lodge stay begins tomorrow!\n\n" +
      "Guest list:\n\n{{guestFirstName}} {{guestLastName}}\n\nSee you there.";

    const rendered = renderTemplateString(savedOverrideBody, templateData);

    for (const guest of GUESTS) {
      expect(rendered).toContain(`${guest.firstName} ${guest.lastName}`);
    }
    // One guest per line, and no surname stranded on a line of its own.
    expect(rendered).toContain("Ada Lovelace\nBob Smith\nCleo Jones");
    expect(rendered).not.toContain("Ada, Bob");
    expect(rendered).not.toContain("Lovelace, Smith");
    expect(rendered).not.toContain("{{");
  });

  it("leaves no dangling space or empty block once the body is laid out", async () => {
    // The literal space the saved body puts BETWEEN the two tokens is what makes
    // the mapping (list, empty) safe rather than merely correct-ish:
    // plainTextEmailTemplate trims every blank-line-separated block, so that
    // space disappears at the end of the last line, and a booking with no guests
    // collapses the whole block away instead of leaving a stray blank paragraph.
    const { sendCheckinReminderEmail } = await import("../email/booking");
    const { renderTemplateString } = await import("../email-message-renderer");
    const { plainTextEmailTemplate } = await import("../email-templates");
    const savedOverrideBody =
      "Check-in Reminder\n\nGuest list:\n\n{{guestFirstName}} {{guestLastName}}\n\nSee you there.";

    await sendCheckinReminderEmail(
      { bookingId: "bk_test" },
      "member@example.org",
      "Sam",
      CHECK_IN,
      CHECK_OUT,
      GUESTS,
      [],
    );
    const withGuests = plainTextEmailTemplate(
      renderTemplateString(
        savedOverrideBody,
        sendEmailMock.mock.calls[0][0].templateData,
      ),
    );
    expect(withGuests).toContain("Cleo Jones</div>");

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
    const withNoGuests = plainTextEmailTemplate(
      renderTemplateString(
        savedOverrideBody,
        sendEmailMock.mock.calls[0][0].templateData,
      ),
    );
    // "Guest list:" and "See you there." survive; the empty list block does not
    // become a paragraph containing a single space.
    expect(withNoGuests).toContain("Guest list:");
    expect(withNoGuests).toContain("See you there.");
    expect(withNoGuests).not.toMatch(/>\s+<\/div>/);
  });

  it("keeps a body that uses ONE of the old tokens truthful", async () => {
    const { sendCheckinReminderEmail } = await import("../email/booking");
    const { renderTemplateString } = await import("../email-message-renderer");
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

    // {{guestFirstName}} alone still names everybody, in full.
    expect(renderTemplateString("{{guestFirstName}}", templateData)).toBe(
      "Ada Lovelace\nBob Smith\nCleo Jones",
    );
    // {{guestLastName}} alone shows NOBODY rather than a bare list of surnames.
    // A surname-only list is precisely how the original bug misattributed
    // people, so an empty render is the only truthful answer available.
    expect(renderTemplateString("{{guestLastName}}", templateData)).toBe("");
  });

  it("keeps a club holding the legacy pair able to save its own template", async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the #2269 review showed the
    // old assertion was the bug rather than the contract.
    //
    // Each template's allowedTokens are derived from its DEFAULT body, so when
    // the default moved to {{guestName}} the legacy pair fell out of the
    // allowed set — even though the sender above STILL SUPPLIES BOTH, on
    // purpose, so that a club holding a pre-#2307 override keeps naming its
    // guests. The consequences of that mismatch were both wrong and both
    // reached a real club: the editor said the pair was "no longer supplied"
    // (false — see the render assertions above), and, because a disallowed
    // token makes the whole validation invalid, that club could not re-save
    // its template at all. The only remedy the screen offered was Restore
    // Default, which destroys the very wording the back-compatibility exists
    // to protect.
    //
    // Both tokens are now declared in EXTRA_TEMPLATE_TOKENS — the register for
    // exactly this case, "supplied by the sender, not in the default body".
    const { validateEmailTemplateContent } = await import(
      "../email-message-renderer"
    );
    const result = validateEmailTemplateContent({
      templateName: "checkin-reminder",
      subject: "Check-in Reminder",
      bodyText: "Guest list:\n\n{{guestFirstName}} {{guestLastName}}",
    });

    expect(result.valid).toBe(true);
    expect(result.disallowedTokens).toEqual([]);
    expect(result.unknownTokens).toEqual([]);
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
