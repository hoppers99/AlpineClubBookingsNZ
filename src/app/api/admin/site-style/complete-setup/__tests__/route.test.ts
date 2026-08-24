import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_THEME_ID } from "@/lib/club-theme-schema";

/**
 * `POST /api/admin/site-style/complete-setup` (#220 review F3).
 *
 * The route exists to make ONE column true without a theme in the request, so
 * the three things it has to get right are all about restraint: it must refuse
 * before it writes, it must write nothing but `completedAt`, and it must not
 * move a completion time that already exists.
 *
 * The lock and the guarded claim are exercised through mocked Prisma delegates,
 * which pins the SHAPE of the transaction (materialise, `FOR UPDATE`, claim on
 * `completedAt: null`) rather than its behaviour under real contention — the
 * real-Postgres lock harnesses in CI's `migration-drift` job own that half.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createMany: vi.fn(),
  executeRaw: vi.fn(),
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  transaction: vi.fn(),
  logAudit: vi.fn(),
  revalidatePath: vi.fn(),
  revalidatePublicSite: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: mocks.revalidatePublicSite,
}));
vi.mock("@/lib/public-layout-cache", () => ({
  PUBLIC_LAYOUT_CACHE_TAGS: { theme: "public-layout:theme" },
  invalidatePublicLayoutConfig: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const txClient = {
  clubTheme: {
    createMany: mocks.createMany,
    updateMany: mocks.updateMany,
    findUnique: mocks.findUnique,
  },
  $executeRaw: mocks.executeRaw,
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: typeof txClient) => unknown, options?: unknown) =>
      mocks.transaction(fn, options),
  },
}));

import { POST } from "@/app/api/admin/site-style/complete-setup/route";

describe("POST /api/admin/site-style/complete-setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.createMany.mockResolvedValue({ count: 0 });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue({ completedAt: new Date("2026-07-01") });
    mocks.transaction.mockImplementation((fn: (tx: typeof txClient) => unknown) =>
      fn(txClient),
    );
  });

  // The gate. Mutation-verified: dropping the `permission` argument, or
  // lowering it to `view`, fails this test.
  it("asks for content EDIT, the same privilege the site-style PUT asks for", async () => {
    await POST();
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "content", level: "edit" },
    });
  });

  it("refuses before writing anything when the guard says no", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });

    const response = await POST();
    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  // The whole point of the endpoint: no theme goes in, so no theme can be
  // clobbered by a stale read.
  it("writes completedAt and NOTHING else, under the row lock", async () => {
    await POST();

    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ id: CLUB_THEME_ID })],
      skipDuplicates: true,
    });
    expect(mocks.executeRaw).toHaveBeenCalled();

    const [claim] = mocks.updateMany.mock.calls[0];
    expect(claim.where).toEqual({ id: CLUB_THEME_ID, completedAt: null });
    expect(Object.keys(claim.data)).toEqual(["completedAt"]);
    expect(claim.data.completedAt).toBeInstanceOf(Date);
  });

  it("reports the site live and audits the transition once", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isComplete: true });
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "site_style.updated",
        category: "admin",
        severity: "important",
        memberId: "admin-1",
        summary: "Completed public site style setup",
      }),
    );
  });

  // Idempotent: a second click, a double submit or a retry finds the row
  // already stamped. It must not move the original time, and must not lay down
  // a second "completed setup" audit row for a transition that did not happen.
  it("is a no-op on a site that is already visible", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const response = await POST();
    expect(await response.json()).toEqual({ isComplete: true });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("clears the public caches that were painting the holding screen", async () => {
    await POST();
    expect(mocks.revalidatePublicSite).toHaveBeenCalledWith("public-layout:theme");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/(admin)", "layout");
  });

  it("answers 500 rather than a false success when the write throws", async () => {
    mocks.transaction.mockRejectedValue(new Error("db down"));
    const response = await POST();
    expect(response.status).toBe(500);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});
