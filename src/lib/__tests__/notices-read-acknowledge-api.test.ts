import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  getNoticeForMember: vi.fn(),
  receiptUpsert: vi.fn(),
  receiptUpdateMany: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));

vi.mock("@/lib/notices", () => ({
  getNoticeForMember: mocks.getNoticeForMember,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    noticeReadReceipt: {
      upsert: mocks.receiptUpsert,
      updateMany: mocks.receiptUpdateMany,
    },
  },
}));

import { POST as postRead } from "@/app/api/notices/[id]/read/route";
import { POST as postAck } from "@/app/api/notices/[id]/acknowledge/route";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function noticeView(overrides: Record<string, unknown> = {}) {
  return {
    id: "notice-1",
    title: "T",
    bodyHtml: "<p>x</p>",
    publishedAt: null,
    expiresAt: null,
    pinned: false,
    requiresAcknowledgement: false,
    read: false,
    readAt: null,
    acknowledged: false,
    acknowledgedAt: null,
    ...overrides,
  };
}

const okSession = {
  ok: true as const,
  session: { user: { id: "member-1" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSession.mockResolvedValue(okSession);
  mocks.getNoticeForMember.mockResolvedValue(noticeView());
  mocks.receiptUpsert.mockResolvedValue({});
  mocks.receiptUpdateMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/notices/[id]/read", () => {
  it("returns 401 when there is no active session", async () => {
    mocks.requireActiveSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });

    const res = await postRead(new Request("http://x"), params("notice-1"));
    expect(res.status).toBe(401);
    expect(mocks.receiptUpsert).not.toHaveBeenCalled();
  });

  it("returns 404 when the notice is out of audience", async () => {
    mocks.getNoticeForMember.mockResolvedValue(null);

    const res = await postRead(new Request("http://x"), params("notice-x"));
    expect(res.status).toBe(404);
    expect(mocks.receiptUpsert).not.toHaveBeenCalled();
  });

  it("upserts a receipt keyed on the SESSION member id, never overwriting readAt", async () => {
    const res = await postRead(new Request("http://x"), params("notice-1"));
    expect(res.status).toBe(200);
    expect(mocks.receiptUpsert).toHaveBeenCalledWith({
      where: { noticeId_memberId: { noticeId: "notice-1", memberId: "member-1" } },
      create: { noticeId: "notice-1", memberId: "member-1" },
      update: {},
    });
  });

  it("audience re-check is by the session member id (not any body value)", async () => {
    await postRead(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ memberId: "attacker" }),
      }),
      params("notice-1"),
    );
    expect(mocks.getNoticeForMember).toHaveBeenCalledWith("member-1", "notice-1");
  });
});

describe("POST /api/notices/[id]/acknowledge", () => {
  it("returns 401 when there is no active session", async () => {
    mocks.requireActiveSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });

    const res = await postAck(new Request("http://x"), params("notice-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when out of audience", async () => {
    mocks.getNoticeForMember.mockResolvedValue(null);
    const res = await postAck(new Request("http://x"), params("notice-x"));
    expect(res.status).toBe(404);
    expect(mocks.receiptUpsert).not.toHaveBeenCalled();
  });

  it("returns 400 when the notice does not require acknowledgement", async () => {
    mocks.getNoticeForMember.mockResolvedValue(
      noticeView({ requiresAcknowledgement: false }),
    );
    const res = await postAck(new Request("http://x"), params("notice-1"));
    expect(res.status).toBe(400);
    expect(mocks.receiptUpsert).not.toHaveBeenCalled();
  });

  it("stamps acknowledgedAt once via a null-guarded updateMany", async () => {
    mocks.getNoticeForMember.mockResolvedValue(
      noticeView({ requiresAcknowledgement: true }),
    );

    const res = await postAck(new Request("http://x"), params("notice-1"));
    expect(res.status).toBe(200);
    // Ensures a receipt exists without overwriting an existing one.
    expect(mocks.receiptUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          noticeId_memberId: { noticeId: "notice-1", memberId: "member-1" },
        },
        update: {},
      }),
    );
    // Sets acknowledgedAt only where still null (idempotent).
    const updateArgs = mocks.receiptUpdateMany.mock.calls[0][0];
    expect(updateArgs.where).toMatchObject({
      noticeId: "notice-1",
      memberId: "member-1",
      acknowledgedAt: null,
    });
  });
});
