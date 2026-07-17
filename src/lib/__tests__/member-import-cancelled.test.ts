// Issue #1946: the member CSV import can create a member directly in the
// cancelled end-state via an optional Cancelled Date column. These tests
// exercise the POST /api/admin/members/import route to confirm the cancelled
// row is created inactive + non-login with cancelledAt set, that a cancelled
// row never claims the login for a shared email, that a future cancelled date
// is rejected, and that an existing member is skipped (never cancelled) so the
// import stays create-only.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    memberFieldsSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    memberAccessRole: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passwordResetToken: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/email", () => ({ sendMemberSetupInviteEmail: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));

import { prisma } from "@/lib/prisma";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { POST as importMembers } from "@/app/api/admin/members/import/route";

const fullAdminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

type CreatedMemberData = Record<string, unknown>;
const createdMemberData: CreatedMemberData[] = [];

function mockCreateTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
    fn({
      member: {
        create: vi.fn(async ({ data }: any) => {
          createdMemberData.push(data);
          return {
            id: `new-${createdMemberData.length}`,
            email: data.email,
            firstName: data.firstName,
            lastName: data.lastName,
            canLogin: data.canLogin,
          };
        }),
      },
      memberAccessRole: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }),
  );
}

function importRequest(body: Record<string, unknown>) {
  return importMembers(
    new NextRequest("http://localhost/api/admin/members/import", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("issue #1946 — importing cancelled members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdMemberData.length = 0;
    mockRequireAdmin.mockResolvedValue(fullAdminGuard);
    vi.mocked(prisma.memberFieldsSettings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.member.findMany).mockResolvedValue([]);
    mockCreateTransaction();
  });

  it("creates a member in the cancelled end-state when a cancelled date is given", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Cora",
          lastName: "Cancelled",
          email: "cora@example.com",
          cancelledDate: "2020-06-30",
        },
      ],
      sendInvites: true,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(1);
    expect(data.createdCancelled).toBe(1);
    expect(data.createdLoginEnabled).toBe(0);
    expect(data.createdNonLogin).toBe(1);

    expect(createdMemberData).toHaveLength(1);
    const created = createdMemberData[0];
    expect(created.active).toBe(false);
    expect(created.canLogin).toBe(false);
    expect(created.cancelledAt).toBeInstanceOf(Date);
    expect((created.cancelledAt as Date).toISOString()).toBe(
      "2020-06-30T00:00:00.000Z",
    );
    // No cancellation request exists for a legacy import.
    expect(created.cancelledViaRequestId).toBeUndefined();

    // A cancelled member is never sent a setup invite, even with sendInvites.
    expect(vi.mocked(sendMemberSetupInviteEmail)).not.toHaveBeenCalled();
  });

  it("does not let a cancelled row claim the login for a shared email", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Cora",
          lastName: "Cancelled",
          email: "shared@example.com",
          cancelledDate: "2020-06-30",
        },
        {
          firstName: "Active",
          lastName: "Ann",
          email: "shared@example.com",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(2);
    expect(data.createdCancelled).toBe(1);
    // The active row keeps the login for the shared email.
    expect(data.createdLoginEnabled).toBe(1);

    const cancelled = createdMemberData.find(
      (row) => row.firstName === "Cora",
    );
    const active = createdMemberData.find((row) => row.firstName === "Active");
    expect(cancelled?.canLogin).toBe(false);
    expect(cancelled?.active).toBe(false);
    expect(active?.canLogin).toBe(true);
    expect(active?.active).toBe(true);
    expect(active?.cancelledAt).toBeNull();
  });

  it("rejects a future cancelled date and creates nobody", async () => {
    const res = await importRequest({
      rows: [
        {
          firstName: "Fred",
          lastName: "Future",
          email: "fred@example.com",
          cancelledDate: "2999-01-01",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(
      data.errors[0].errors.some((error: string) =>
        error.toLowerCase().includes("future"),
      ),
    ).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(createdMemberData).toHaveLength(0);
  });

  it("skips an existing member instead of cancelling them (create-only import)", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        email: "existing@example.com",
        firstName: "Existing",
        lastName: "Member",
        dateOfBirth: null,
        canLogin: true,
      },
    ] as any);

    const res = await importRequest({
      rows: [
        {
          firstName: "Existing",
          lastName: "Member",
          email: "existing@example.com",
          cancelledDate: "2020-06-30",
        },
      ],
      sendInvites: false,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(0);
    expect(data.skipped).toBe(1);
    // The existing member is untouched: no create, no cancellation write.
    expect(createdMemberData).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
