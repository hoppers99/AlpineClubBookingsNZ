import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/bookings/[id]/additional-payment-reminder (#2350).
 *
 * The route is thin on purpose — the decisions live in the service — so what it
 * has to get right is the gate and the shape of a refusal: an admin-only
 * permission, the service's own status code passed through rather than flattened
 * into a generic 400, and a plain-English message the officer can act on.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  resendAdditionalPaymentEmail: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/additional-payment-resend-service", () => ({
  resendAdditionalPaymentEmail: mocks.resendAdditionalPaymentEmail,
}));
vi.mock("@/lib/audit", () => ({
  getAuditRequestContext: () => ({
    id: "req_1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  }),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/bookings/[id]/additional-payment-reminder/route";

const params = Promise.resolve({ id: "bk_1" });

function request() {
  return new NextRequest(
    "http://localhost/api/admin/bookings/bk_1/additional-payment-reminder",
    { method: "POST", headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin_1" } },
  });
  mocks.resendAdditionalPaymentEmail.mockResolvedValue({
    ok: true,
    sentAt: new Date("2026-06-10T22:00:00.000Z"),
    additionalAmountCents: 21_000,
  });
});

describe("admin additional-payment reminder route", () => {
  it("requires the bookings edit permission", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await POST(request(), { params });

    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level: "edit" },
    });
    expect(mocks.resendAdditionalPaymentEmail).not.toHaveBeenCalled();
  });

  it("sends on behalf of the signed-in admin and reports the amount", async () => {
    const response = await POST(request(), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      additionalAmountCents: 21_000,
    });
    expect(mocks.resendAdditionalPaymentEmail).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "bk_1", actorMemberId: "admin_1" }),
    );
  });

  it("passes a refusal through with its own status and message", async () => {
    mocks.resendAdditionalPaymentEmail.mockResolvedValue({
      ok: false,
      status: 429,
      error: "A payment request was already emailed to this member.",
    });

    const response = await POST(request(), { params });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "A payment request was already emailed to this member.",
    });
  });

  it("never leaks an unexpected error's message to the caller", async () => {
    mocks.resendAdditionalPaymentEmail.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.7:5432"),
    );

    const response = await POST(request(), { params });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to send the payment request email");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
