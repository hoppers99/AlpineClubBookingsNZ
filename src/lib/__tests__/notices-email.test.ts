import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  resolveAudience: vi.fn(),
  noticeFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  getAppBaseUrl: vi.fn(() => "http://x"),
}));

vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/email-templates", () => ({ noticePublishedTemplate: () => "<html></html>" }));
vi.mock("@/lib/app-url", () => ({ getAppBaseUrl: mocks.getAppBaseUrl }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));
vi.mock("@/lib/notices", () => ({ resolveNoticeAudienceMembers: mocks.resolveAudience }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notice: { findUnique: mocks.noticeFindUnique },
    member: { findMany: mocks.memberFindMany },
  },
}));

import { sendNoticePublishedEmails } from "@/lib/notices-email";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.noticeFindUnique.mockResolvedValue({
    id: "notice-1",
    title: "Hut closed",
    status: "PUBLISHED",
  });
  mocks.sendEmail.mockResolvedValue({ status: "sent" });
});

it("does nothing for a notice that is not published", async () => {
  mocks.noticeFindUnique.mockResolvedValue({ id: "n", title: "t", status: "DRAFT" });
  const result = await sendNoticePublishedEmails("n");
  expect(result).toEqual({ sent: 0, skipped: 0 });
  expect(mocks.sendEmail).not.toHaveBeenCalled();
});

it("emails only members opted in to marketingEmails", async () => {
  mocks.resolveAudience.mockResolvedValue([
    { memberId: "m1", name: "A", email: "a@x.test", audienceVia: "All members", viaExplicitMember: false },
    { memberId: "m2", name: "B", email: "b@x.test", audienceVia: "All members", viaExplicitMember: false },
  ]);
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", notificationPreference: { marketingEmails: true } },
    { id: "m2", firstName: "B", notificationPreference: { marketingEmails: false } },
  ]);

  const result = await sendNoticePublishedEmails("notice-1");

  expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  expect(mocks.sendEmail.mock.calls[0][0].to).toBe("a@x.test");
  expect(result.sent).toBe(1);
  // m2 opted out -> skipped.
  expect(result.skipped).toBe(1);
});

it("counts a suppressed recipient as skipped (suppression enforced inside sendEmail)", async () => {
  mocks.resolveAudience.mockResolvedValue([
    { memberId: "m1", name: "A", email: "a@x.test", audienceVia: "All members", viaExplicitMember: false },
  ]);
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", notificationPreference: { marketingEmails: true } },
  ]);
  mocks.sendEmail.mockResolvedValue({ status: "suppressed" });

  const result = await sendNoticePublishedEmails("notice-1");
  expect(result.sent).toBe(0);
  expect(result.skipped).toBe(1);
});

it("treats a member with no preference row as opted out", async () => {
  mocks.resolveAudience.mockResolvedValue([
    { memberId: "m1", name: "A", email: "a@x.test", audienceVia: "All members", viaExplicitMember: false },
  ]);
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", notificationPreference: null },
  ]);

  const result = await sendNoticePublishedEmails("notice-1");
  expect(mocks.sendEmail).not.toHaveBeenCalled();
  expect(result.skipped).toBe(1);
});
