import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_THEME_ID } from "@/lib/club-theme-schema";

/**
 * `POST /api/admin/site-style/complete-setup` (#220 review F3, gated by C16/#247).
 *
 * The route exists to make ONE column true without a theme in the request, so
 * the three things it has to get right are all about restraint: it must refuse
 * before it writes, it must write nothing but `completedAt`, and it must not
 * move a completion time that already exists.
 *
 * C16 (#247) added a fourth: it must refuse while nothing has said which
 * installation this is. That gate runs through the REAL
 * `resolveEnvironmentRole` here — `declareEnvironmentRole` plus an
 * `environmentSafetySettings` delegate, both halves — rather than through a
 * stubbed role, so the route is proved against the resolver's own answers. The
 * gate's own polarity tests live in `site-visibility-gate.test.ts`.
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
  environmentSafetyFindUnique: vi.fn(),
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
    // Present, so the safer override's ANSWER decides the role rather than the
    // delegate's absence. Without it every test in this file would run under an
    // unreadable override, resolve UNKNOWN, and assert against the refusal path
    // by accident.
    environmentSafetySettings: {
      findUnique: (...args: unknown[]) => mocks.environmentSafetyFindUnique(...args),
    },
  },
}));

import { POST } from "@/app/api/admin/site-style/complete-setup/route";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";
import { stubHealthyLaunchGateEnv } from "@/lib/__tests__/helpers/setup-launch-gate";

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
    // A declared production installation with no safer override: the ordinary
    // state of the club's live site, and the one every test below but the
    // environment ones means to be running in.
    mocks.environmentSafetyFindUnique.mockResolvedValue(null);
    declareEnvironmentRole("production");
    // C15 fix round on #247: the gate now also checks `runtime-env` and
    // `auth-secret-strength`, both read straight from `process.env`, so every
    // test below that means to reach a successful publish needs a healthy
    // deployment declared alongside the role.
    stubHealthyLaunchGateEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  /**
   * C16 (#247). `content: edit` answers "may this administrator publish". These
   * answer the question it never asked: should this INSTALLATION be publishing
   * at all.
   */
  describe("the environment gate", () => {
    it("runs the premise it thinks it runs", async () => {
      // One environment failure that says what is wrong, rather than a dozen
      // assertions below reading like the product bug they exist to disprove.
      await expectEnvironmentRolePremise("PRODUCTION");
    });

    it("refuses 409 while nothing has declared this installation, and writes nothing", async () => {
      undeclareEnvironmentRole();
      await expectEnvironmentRolePremise("UNKNOWN");

      const response = await POST();

      expect(response.status).toBe(409);
      // Refused BEFORE the write, so no row moves, no cache is dropped and the
      // audit trail records no publication that did not happen.
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.updateMany).not.toHaveBeenCalled();
      expect(mocks.logAudit).not.toHaveBeenCalled();
      expect(mocks.revalidatePublicSite).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it("tells the operator what to do about it", async () => {
      undeclareEnvironmentRole();

      const response = await POST();
      const body = (await response.json()) as { error: string };

      expect(body.error).toContain("APP_ENVIRONMENT_ROLE");
      expect(body.error).toContain("Admin › Environment");
      // All three of UNKNOWN's causes reach an operator through this route, so
      // all three repairs travel with it — including the one neither
      // declaration fixes. The wording itself is settled in
      // `site-visibility-gate.test.ts`; this pins that the whole message
      // arrives here rather than a shortened one.
      expect(body.error).toContain("prisma migrate deploy");
      expect(body.error).toContain("INV-CONFIG-006");
      // The launch panel throws on `!response.ok || body.isComplete !== true`
      // and renders `body.error`, so a refusal must NOT come back claiming the
      // site is live.
      expect(body).not.toHaveProperty("isComplete");
    });

    it("refuses a DECLARED PRODUCTION whose safer override could not be read", async () => {
      // The direction a "refuse only when undeclared" gate would get wrong: the
      // declaration says production, but an administrator may already have
      // forced this installation safer and there is no way to tell from here.
      mocks.environmentSafetyFindUnique.mockRejectedValue(new Error("no relation"));
      await expectEnvironmentRolePremise("UNKNOWN");

      const response = await POST();

      expect(response.status).toBe(409);
      expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("lets a declared copy publish its own public site", async () => {
      declareEnvironmentRole("non-production");
      await expectEnvironmentRolePremise("NON_PRODUCTION");

      const response = await POST();

      expect(response.status).toBe(200);
      expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
