import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  emailTemplateOverrideFindUnique: vi.fn(),
  emailTemplateOverrideUpsert: vi.fn(),
  emailTemplateOverrideFindMany: vi.fn(),
  emailTemplateOverrideDeleteMany: vi.fn(),
  emailMessageSettingFindUnique: vi.fn(),
  emailMessageSettingUpsert: vi.fn(),
  notificationDeliveryPolicyFindUnique: vi.fn(),
  notificationDeliveryPolicyUpsert: vi.fn(),
  notificationDeliveryPolicyFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailTemplateOverride: {
      findUnique: mocks.emailTemplateOverrideFindUnique,
      upsert: mocks.emailTemplateOverrideUpsert,
      findMany: mocks.emailTemplateOverrideFindMany,
      deleteMany: mocks.emailTemplateOverrideDeleteMany,
    },
    emailMessageSetting: {
      findUnique: mocks.emailMessageSettingFindUnique,
      upsert: mocks.emailMessageSettingUpsert,
    },
    notificationDeliveryPolicy: {
      findUnique: mocks.notificationDeliveryPolicyFindUnique,
      upsert: mocks.notificationDeliveryPolicyUpsert,
      findMany: mocks.notificationDeliveryPolicyFindMany,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

import {
  GET as getEmailTemplates,
  PUT as putEmailTemplate,
} from "@/app/api/admin/email-templates/route";
import { POST as previewEmailTemplate } from "@/app/api/admin/email-templates/preview/route";
import { POST as resetEmailTemplate } from "@/app/api/admin/email-templates/reset/route";
import { PUT as putEmailSettings } from "@/app/api/admin/email-settings/route";
import {
  GET as getDeliveryPolicies,
  PUT as putDeliveryPolicy,
} from "@/app/api/admin/notification-delivery-policies/route";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postRequest(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin email message APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.emailTemplateOverrideFindUnique.mockResolvedValue(null);
    mocks.emailTemplateOverrideUpsert.mockResolvedValue({
      id: "override-1",
      templateName: "password-reset",
      subject: "Reset your password",
      bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
      updatedByMemberId: "admin-1",
    });
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([]);
    mocks.emailTemplateOverrideDeleteMany.mockResolvedValue({ count: 1 });
    mocks.emailMessageSettingFindUnique.mockResolvedValue(null);
    mocks.emailMessageSettingUpsert.mockImplementation(({ update }) =>
      Promise.resolve({
        id: "default",
        ...update,
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
      }),
    );
    mocks.notificationDeliveryPolicyFindUnique.mockResolvedValue(null);
    mocks.notificationDeliveryPolicyUpsert.mockResolvedValue({
      id: "policy-1",
      templateName: "admin-daily-digest",
      mode: "DISABLED",
      updatedByMemberId: "admin-1",
    });
    mocks.notificationDeliveryPolicyFindMany.mockResolvedValue([]);
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("blocks non-admin users", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });

    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it("blocks non-admin users from updating email settings", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });

    const response = await putEmailSettings(
      request("/api/admin/email-settings", { clubName: "Hacked Club" }),
    );

    expect(response.status).toBe(403);
    expect(mocks.emailMessageSettingUpsert).not.toHaveBeenCalled();
  });

  it("honors inactive-user blocking", async () => {
    mocks.requireActiveSessionUser.mockResolvedValue(
      new Response(JSON.stringify({ error: "Inactive user" }), { status: 403 }),
    );

    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it("rejects unsafe email template edits", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "password-reset",
        subject: "Reset\npassword",
        bodyText: "<strong>Reset</strong> javascript:alert(1)",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid email template");
    expect(body.missingRequiredTokens).toContain("token");
    expect(body.unsafeLinks).toContain("javascript:alert(1)");
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  // #2267 (owner decision on PR #2311): the promo explanation is required
  // content on the payment confirmation, and the rejection has to arrive at the
  // editor as something an admin can act on — the panel joins these issue
  // messages onto its error toast.
  it("rejects a booking-confirmed override that drops the promo explanation", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "See you soon - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.missingRequiredTokens).toEqual(["promoSummary"]);
    expect(
      body.issues.map((issue: { message: string }) => issue.message).join(" "),
    ).toContain("must show members how a promo code changed their price");
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it("keeps saving a legacy booking-confirmed override that shows the promo its own way", async () => {
    // The pre-#2267 shipped default's promo lines: subtotal, a hand-written
    // "Discount ({{promoCode}}): -{{discount}}" row, then the total. Every
    // override a club saved from that default must keep re-saving.
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "See you soon - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\nSubtotal: {{subtotal}}\nDiscount ({{promoCode}}): -{{discount}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailTemplateOverrideUpsert).toHaveBeenCalled();
  });

  it("rejects override subjects containing the door code token", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "Door code {{doorCode}} - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid email template");
    expect(body.sensitiveSubjectTokens).toContain("doorCode");
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it.each([
    {
      templateName: "chore-roster",
      subject: "Complete your chores: {{choreLink}}",
      bodyText:
        "Hi {{guestName}}, mark {{choreName}} complete: {{choreLink}}",
      sensitiveToken: "choreLink",
    },
    {
      templateName: "booking-request-quote",
      subject: "Respond to your quote: {{respondUrl}}",
      bodyText:
        "Respond here: {{BASE_URL}}/booking-requests/respond/{{token}}",
      sensitiveToken: "respondUrl",
    },
    {
      templateName: "nomination-request",
      subject: "Review this nomination: {{reviewUrl}}",
      bodyText:
        "Review {{applicantName}} here: {{BASE_URL}}/nominations/{{token}}",
      sensitiveToken: "reviewUrl",
    },
  ])(
    "rejects $templateName subjects containing $sensitiveToken",
    async ({ templateName, subject, bodyText, sensitiveToken }) => {
      const response = await putEmailTemplate(
        request("/api/admin/email-templates", {
          templateName,
          subject,
          bodyText,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid email template");
      expect(body.sensitiveSubjectTokens).toContain(sensitiveToken);
      expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
    },
  );

  it("saves booking-confirmed overrides with the door code only in the body", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "booking-confirmed",
        subject: "See you soon - {{CLUB_LODGE_NAME}}",
        bodyText:
          "Hi {{firstName}}.\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailTemplateOverrideUpsert).toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("saves valid template edits and audit logs the change", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailTemplateOverrideUpsert).toHaveBeenCalledWith({
      where: { templateName: "password-reset" },
      create: expect.objectContaining({
        templateName: "password-reset",
        updatedByMemberId: "admin-1",
      }),
      update: expect.objectContaining({
        updatedByMemberId: "admin-1",
      }),
    });
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "mailto:support@example.org",
    "ftp://bookings.example.org",
  ])("rejects non-http public URLs: %s", async (publicUrl) => {
    const response = await putEmailSettings(
      request("/api/admin/email-settings", { publicUrl }),
    );

    expect(response.status).toBe(400);
    expect(mocks.emailMessageSettingUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["https://bookings.example.org///", "https://bookings.example.org"],
    ["http://localhost:3000/", "http://localhost:3000"],
  ])("accepts and normalizes http public URLs", async (publicUrl, normalized) => {
    const response = await putEmailSettings(
      request("/api/admin/email-settings", { publicUrl }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailMessageSettingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          publicUrl: normalized,
        }),
        update: expect.objectContaining({
          publicUrl: normalized,
        }),
      }),
    );
  });

  it("saves club-field updates and audit logs the changed keys", async () => {
    const response = await putEmailSettings(
      request("/api/admin/email-settings", { clubName: "River Valley Club" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.emailMessageSettingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ clubName: "River Valley Club" }),
        update: expect.objectContaining({ clubName: "River Valley Club" }),
      }),
    );

    const auditPayload = mocks.auditLogCreate.mock.calls.at(-1)?.[0];
    expect(auditPayload.data.metadata.changedKeys).toEqual(["clubName"]);
  });

  it("rejects the retired lodge-identity fields", async () => {
    for (const field of [
      { lodgeName: "Ghost Lodge" },
      { lodgeTravelNote: "n/a" },
      { doorCode: "2468" },
    ]) {
      const response = await putEmailSettings(
        request("/api/admin/email-settings", field),
      );
      expect(response.status).toBe(400);
    }
    // Lodge identity now lives on the Lodge table; the strict settings schema
    // no longer accepts these keys, so nothing is persisted.
    expect(mocks.emailMessageSettingUpsert).not.toHaveBeenCalled();
  });

  it("reports stale template overrides without listing them as current templates", async () => {
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([
      {
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        templateName: "retired-template",
        subject: "Retired",
        bodyText: "Old content",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getEmailTemplates();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.templates.some((template: { key: string }) => template.key === "retired-template")).toBe(false);
    expect(
      body.templates.find((template: { key: string }) => template.key === "password-reset")
        .override.subject,
    ).toBe("Reset your password");
    expect(body.staleOverrideCount).toBe(1);
    expect(body.staleOverrides).toEqual([
      expect.objectContaining({ templateName: "retired-template" }),
    ]);
  });

  // #2320 review (MED-1): a saved override authored from the pre-#2268 editor
  // text still carries the "[only when …]" junk as literal recipient-facing
  // content. The GET names every such row so the panel can flag them without
  // an admin opening each template, and the PUT refuses to (re-)save one.
  it("flags saved overrides that still carry bracket authoring notes", async () => {
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([
      {
        // A clean override is not flagged.
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        // The pre-sweep shape: junk in the body of a registered template.
        templateName: "pre-arrival-reminder",
        subject: "Pre-arrival Information",
        bodyText:
          "Hi {{firstName}}.\n\nDoor code: {{doorCode}} [only when a door code is set]",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        // A STALE row with junk is flagged too — an operator deciding what to
        // re-author needs to know the old text was carrying it.
        templateName: "refund-request-resolved",
        subject: "Refund Appeal Approved [only when approved]",
        bodyText: "Old combined body",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getEmailTemplates();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bracketAnnotationOverrides).toEqual([
      {
        templateName: "pre-arrival-reminder",
        annotations: ["[only when a door code is set]"],
      },
      {
        templateName: "refund-request-resolved",
        annotations: ["[only when approved]"],
      },
    ]);
  });

  it("names saved overrides that still use a token their template no longer offers", async () => {
    // #2307 review (M2). A token a template stopped supplying renders as
    // NOTHING — there is no conditional syntax and no error — so an override
    // written against an older default keeps sending with a hole in it. The
    // live example: the check-in reminder's guest list moved from
    // {{guestFirstName}} {{guestLastName}} on one line to a one-per-line
    // {{guestName}}, and a club holding the old pair would have emailed a
    // reminder that listed nobody at all. The sender keeps supplying the old
    // pair so those overrides still render correctly; this banner is how the
    // admin learns to move off them.
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([
      {
        // Current wording: not flagged.
        templateName: "password-reset",
        subject: "Reset your password",
        bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        templateName: "checkin-reminder",
        subject: "Check-in Reminder",
        bodyText: [
          "Hi {{firstName}}.",
          "",
          "Guest list:",
          "",
          "{{guestFirstName}} {{guestLastName}}",
        ].join("\n"),
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getEmailTemplates();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.retiredTokenOverrides).toEqual([
      {
        templateName: "checkin-reminder",
        tokens: ["guestFirstName", "guestLastName"],
      },
    ]);
  });

  it("does not flag an override that uses the token the template now offers", async () => {
    // The contrast case, so the test above is a statement about RETIRED tokens
    // rather than about the banner firing for every override.
    mocks.emailTemplateOverrideFindMany.mockResolvedValue([
      {
        templateName: "checkin-reminder",
        subject: "Check-in Reminder",
        bodyText: [
          "Hi {{firstName}}.",
          "",
          "Guest list:",
          "",
          "{{guestName}}",
        ].join("\n"),
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getEmailTemplates();
    const body = await response.json();
    expect(body.retiredTokenOverrides).toEqual([]);
  });

  it("refuses to save an override that still carries a bracket authoring note", async () => {
    const response = await putEmailTemplate(
      request("/api/admin/email-templates", {
        templateName: "pre-arrival-reminder",
        subject: "Pre-arrival Information",
        bodyText:
          "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}} [only when a door code is set]",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.bracketAnnotations).toEqual(["[only when a door code is set]"]);
    expect(
      body.issues.some(
        (issue: { code: string }) => issue.code === "bracket_annotation",
      ),
    ).toBe(true);
    expect(mocks.emailTemplateOverrideUpsert).not.toHaveBeenCalled();
  });

  it("lists every registered template from the authoritative TypeScript registry", async () => {
    const response = await getEmailTemplates();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.templates.map((template: { key: string }) => template.key),
    ).toEqual(EMAIL_TEMPLATE_DEFINITIONS.map((definition) => definition.key));
  });

  it("previews every registered template with its default content", async () => {
    for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
      const response = await previewEmailTemplate(
        postRequest("/api/admin/email-templates/preview", {
          templateName: definition.key,
          subject: definition.defaultSubject,
          bodyText: definition.defaultBody,
        }),
      );

      expect(response.status, definition.key).toBe(200);
      const body = await response.json();
      expect(body.subject, definition.key).toBeTypeOf("string");
      expect(body.html, definition.key).toBeTypeOf("string");
    }
  });

  it("saves every registered template with its default content", async () => {
    for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
      const response = await putEmailTemplate(
        request("/api/admin/email-templates", {
          templateName: definition.key,
          subject: definition.defaultSubject,
          bodyText: definition.defaultBody,
        }),
      );

      expect(response.status, definition.key).toBe(200);
    }

    expect(mocks.emailTemplateOverrideUpsert).toHaveBeenCalledTimes(
      EMAIL_TEMPLATE_DEFINITIONS.length,
    );
  });

  it("resets every registered template", async () => {
    for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
      const response = await resetEmailTemplate(
        postRequest("/api/admin/email-templates/reset", {
          templateName: definition.key,
        }),
      );

      expect(response.status, definition.key).toBe(200);
    }

    expect(mocks.emailTemplateOverrideDeleteMany.mock.calls).toEqual(
      EMAIL_TEMPLATE_DEFINITIONS.map((definition) => [
        { where: { templateName: definition.key } },
      ]),
    );
  });

  it("renders membership cancellation refund policy defaults through preview", async () => {
    const templatesResponse = await getEmailTemplates();
    const templatesBody = await templatesResponse.json();
    const confirmationTemplate = templatesBody.templates.find(
      (template: { key: string }) =>
        template.key === "membership-cancellation-confirmation",
    );
    const approvedTemplate = templatesBody.templates.find(
      (template: { key: string }) =>
        template.key === "membership-cancellation-approved",
    );

    expect(confirmationTemplate.defaultBody).toContain(
      "Paid subscriptions are non-refundable",
    );
    expect(confirmationTemplate.defaultBody).toContain(
      "unpaid or overdue subscription invoice will be cancelled",
    );
    expect(approvedTemplate.defaultBody).toContain(
      "Paid subscriptions will not be refunded",
    );
    expect(approvedTemplate.defaultBody).toContain(
      "invoice has been cancelled with a Xero credit note",
    );

    for (const templateName of [
      "membership-cancellation-confirmation",
      "membership-cancellation-approved",
    ] as const) {
      const definition = getEmailTemplateDefinition(templateName);
      expect(definition).toBeDefined();

      const response = await previewEmailTemplate(
        postRequest("/api/admin/email-templates/preview", {
          templateName,
          subject: definition!.defaultSubject,
          bodyText: definition!.defaultBody,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.html).toContain("Xero credit note");
      expect(body.html).toMatch(/Paid subscriptions (are|will)/);
    }
  });

  it("updates editable delivery policies and blocks locked system policies", async () => {
    const lockedResponse = await putDeliveryPolicy(
      request("/api/admin/notification-delivery-policies", {
        templateName: "admin-email-failure",
        mode: "disabled",
      }),
    );

    expect(lockedResponse.status).toBe(400);

    const response = await putDeliveryPolicy(
      request("/api/admin/notification-delivery-policies", {
        templateName: "admin-daily-digest",
        mode: "disabled",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.notificationDeliveryPolicyUpsert).toHaveBeenCalledWith({
      where: { templateName: "admin-daily-digest" },
      create: expect.objectContaining({
        templateName: "admin-daily-digest",
        mode: "DISABLED",
        updatedByMemberId: "admin-1",
      }),
      update: expect.objectContaining({
        mode: "DISABLED",
        updatedByMemberId: "admin-1",
      }),
    });
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("reports stale delivery policies without listing them as current policies", async () => {
    mocks.notificationDeliveryPolicyFindMany.mockResolvedValue([
      {
        templateName: "admin-daily-digest",
        mode: "DISABLED",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
      {
        templateName: "retired-admin-template",
        mode: "ALWAYS",
        updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        updatedByMemberId: "admin-1",
      },
    ]);

    const response = await getDeliveryPolicies();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.policies.some(
        (policy: { templateName: string }) =>
          policy.templateName === "retired-admin-template",
      ),
    ).toBe(false);
    expect(
      body.policies.find(
        (policy: { templateName: string }) =>
          policy.templateName === "admin-daily-digest",
      ).mode,
    ).toBe("disabled");
    expect(body.stalePolicyCount).toBe(1);
    expect(body.stalePolicies).toEqual([
      expect.objectContaining({ templateName: "retired-admin-template" }),
    ]);
  });
});
