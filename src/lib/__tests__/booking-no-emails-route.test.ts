import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2258 setter: POST /api/admin/bookings/[id]/no-emails.
 *
 * Owner decision D10 makes the acknowledgement a HARD server-side requirement,
 * not something the dialog in #2259 can be trusted to supply — a caller that
 * skips it must be refused with nothing written.
 */

const mocks = vi.hoisted(() => {
  const tx = {
    booking: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  return {
    tx,
    requireAdmin: vi.fn(),
    transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    createAuditLog: vi.fn().mockResolvedValue(undefined),
    emailLogFindMany: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    emailLog: { findMany: mocks.emailLogFindMany },
  },
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: () => ({
    id: "req_1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  }),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/bookings/[id]/no-emails/route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/bookings/bk_1/no-emails", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "bk_1" });

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk_1",
    memberId: "mem_1",
    status: "CONFIRMED",
    deletedAt: null,
    noEmails: false,
    noEmailsAt: null,
    noEmailsByMemberId: null,
    waitlistOfferExpiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (cb: (t: unknown) => unknown) =>
    cb(mocks.tx),
  );
  mocks.tx.booking.findUnique.mockResolvedValue(bookingRow());
  mocks.tx.booking.update.mockResolvedValue({});
  mocks.emailLogFindMany.mockResolvedValue([]);
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin_1" } },
  });
});

describe("POST /api/admin/bookings/[id]/no-emails", () => {
  it("403s any non-admin caller and writes nothing", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const res = await POST(request({ noEmails: true, acknowledged: true }), {
      params,
    });

    expect(res.status).toBe(403);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("requires the bookings:edit permission", async () => {
    await POST(request({ noEmails: false }), { params });

    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level: "edit" },
    });
  });

  it("400s an enable with no acknowledgement, and writes nothing", async () => {
    const res = await POST(request({ noEmails: true }), { params });

    expect(res.status).toBe(400);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("400s an enable with acknowledged: false", async () => {
    const res = await POST(request({ noEmails: true, acknowledged: false }), {
      params,
    });

    expect(res.status).toBe(400);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
  });

  it("422s a malformed body", async () => {
    const res = await POST(request({ noEmails: "yes" }), { params });

    expect(res.status).toBe(422);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
  });

  it("enables with an acknowledgement and writes the who/when audit columns", async () => {
    const res = await POST(request({ noEmails: true, acknowledged: true }), {
      params,
    });

    expect(res.status).toBe(200);
    const write = mocks.tx.booking.update.mock.calls[0][0];
    expect(write.where).toEqual({ id: "bk_1" });
    expect(write.data.noEmails).toBe(true);
    expect(write.data.noEmailsByMemberId).toBe("admin_1");
    expect(write.data.noEmailsAt).toBeInstanceOf(Date);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.noEmails.set",
        actorMemberId: "admin_1",
        subjectMemberId: "mem_1",
        entityId: "bk_1",
      }),
      mocks.tx,
    );
  });

  it("clears WITHOUT requiring an acknowledgement and nulls the audit columns", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      bookingRow({
        noEmails: true,
        noEmailsAt: new Date("2026-07-20T00:00:00.000Z"),
        noEmailsByMemberId: "admin_0",
      }),
    );

    const res = await POST(request({ noEmails: false }), { params });

    expect(res.status).toBe(200);
    const write = mocks.tx.booking.update.mock.calls[0][0];
    expect(write.data).toEqual({
      noEmails: false,
      noEmailsAt: null,
      noEmailsByMemberId: null,
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.noEmails.cleared" }),
      mocks.tx,
    );
  });

  it("is idempotent: re-enabling an already-on booking neither rewrites nor re-audits", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      bookingRow({
        noEmails: true,
        noEmailsAt: new Date("2026-07-20T00:00:00.000Z"),
        noEmailsByMemberId: "admin_0",
      }),
    );

    const res = await POST(request({ noEmails: true, acknowledged: true }), {
      params,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      changed: false,
      noEmailsByMemberId: "admin_0",
    });
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  // #2258 review finding: candidacy exclusion only stops FUTURE offers. Turning
  // the switch on over a live offer leaves the clock running with the member
  // never told, so the caller must be able to warn before the admin confirms.
  it("reports a live waitlist offer so the dialog can warn the admin", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      bookingRow({
        status: "WAITLIST_OFFERED",
        waitlistOfferExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );

    const res = await POST(request({ noEmails: true, acknowledged: true }), {
      params,
    });

    await expect(res.json()).resolves.toMatchObject({ hasLiveWaitlistOffer: true });
  });

  it("reports no live offer once the offer has lapsed", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      bookingRow({
        status: "WAITLIST_OFFERED",
        waitlistOfferExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    );

    const res = await POST(request({ noEmails: true, acknowledged: true }), {
      params,
    });

    await expect(res.json()).resolves.toMatchObject({ hasLiveWaitlistOffer: false });
  });

  it("reports no live offer for a booking that is not WAITLIST_OFFERED", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      bookingRow({ waitlistOfferExpiresAt: new Date(Date.now() + 60 * 60 * 1000) }),
    );

    const res = await POST(request({ noEmails: true, acknowledged: true }), {
      params,
    });

    await expect(res.json()).resolves.toMatchObject({ hasLiveWaitlistOffer: false });
  });

  it("404s an unknown or deleted booking", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(null);
    expect(
      (await POST(request({ noEmails: true, acknowledged: true }), { params }))
        .status,
    ).toBe(404);

    mocks.tx.booking.findUnique.mockResolvedValue(
      bookingRow({ deletedAt: new Date() }),
    );
    expect(
      (await POST(request({ noEmails: true, acknowledged: true }), { params }))
        .status,
    ).toBe(404);
  });

  it("returns what has already been withheld so the banner can render it", async () => {
    mocks.emailLogFindMany.mockResolvedValue([
      {
        id: "log_1",
        templateName: "booking-confirmed",
        subject: "Booking Confirmed",
        createdAt: new Date("2026-07-21T00:00:00.000Z"),
      },
    ]);

    const res = await POST(request({ noEmails: true, acknowledged: true }), {
      params,
    });

    await expect(res.json()).resolves.toMatchObject({
      withheldEmails: [expect.objectContaining({ templateName: "booking-confirmed" })],
    });
    expect(mocks.emailLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "bk_1", status: "SKIPPED_NO_EMAILS" },
      }),
    );
  });
});
