import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // The delegate is present, so its ANSWER is what decides the override rather
    // than its absence. A missing delegate is `unreadable` (and therefore
    // UNKNOWN) — the default state of almost every suite in this repository, and
    // a case with its own test below.
    environmentSafetySettings: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  declareEnvironmentRole,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";
import {
  SITE_VISIBILITY_UNKNOWN_ROLE_ERROR,
  refuseSiteVisibilityWhileEnvironmentUnknown,
} from "@/lib/site-visibility-gate";

/**
 * The environment gate on publishing the public site — `INV-CONFIG-006`
 * (epic #213, C16/#247).
 *
 * The gate is four lines, so what is worth testing is not the branch but the
 * POLARITY: which of the resolver's answers let the site go live, and — the part
 * a well-meaning refactor breaks — that the answers meaning "we could not tell"
 * fall on the refusing side. Every case below goes through the REAL
 * `resolveEnvironmentRole`, driven by the two sources it actually reads, so a
 * change to the resolver's own precedence shows up here rather than being hidden
 * behind a stubbed role.
 */

beforeEach(() => {
  vi.clearAllMocks();
  // No override, which is the ordinary state of an installation that has never
  // used the safer switch.
  mockFindUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("refuseSiteVisibilityWhileEnvironmentUnknown (#247)", () => {
  it("lets a declared production installation publish", async () => {
    declareEnvironmentRole("production");
    await expect(refuseSiteVisibilityWhileEnvironmentUnknown()).resolves.toBeNull();
  });

  it("lets a declared NON-PRODUCTION installation publish too", async () => {
    // Deliberate, and not an oversight: an internal staging site is legitimately
    // visible and non-production forever. The wizard's launch panel says exactly
    // that ("the two are independent"), and a gate that refused here would make
    // the panel's own claim false.
    declareEnvironmentRole("non-production");
    await expect(refuseSiteVisibilityWhileEnvironmentUnknown()).resolves.toBeNull();
  });

  it("lets a production installation forced safer by an administrator publish", async () => {
    declareEnvironmentRole("production");
    mockFindUnique.mockResolvedValue({
      forceNonProduction: true,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedByMemberId: "admin1",
    });
    await expect(refuseSiteVisibilityWhileEnvironmentUnknown()).resolves.toBeNull();
  });

  it("refuses when nothing has declared this installation", async () => {
    undeclareEnvironmentRole();

    const refusal = await refuseSiteVisibilityWhileEnvironmentUnknown();

    expect(refusal?.status).toBe(409);
    await expect(refusal?.json()).resolves.toEqual({
      error: SITE_VISIBILITY_UNKNOWN_ROLE_ERROR,
    });
  });

  it("refuses on a declaration it will not guess at", async () => {
    // "staging" is a value somebody plausibly types, and the resolver refuses to
    // interpret it rather than rounding it towards either answer. The gate must
    // follow that refusal instead of treating "something was set" as good enough.
    declareEnvironmentRole("staging");

    const refusal = await refuseSiteVisibilityWhileEnvironmentUnknown();

    expect(refusal?.status).toBe(409);
  });

  it("refuses a DECLARED PRODUCTION whose override could not be read", async () => {
    // THE FAIL-CLOSED CASE, and the one worth having a test of its own. The
    // declaration says production, so a gate written as "refuse only when nobody
    // declared anything" would publish. The resolver answers UNKNOWN instead —
    // an administrator may already have forced this installation safer and there
    // is no way to tell from here — and the gate follows the resolved role, not
    // the declaration.
    declareEnvironmentRole("production");
    mockFindUnique.mockRejectedValue(new Error("relation does not exist"));

    const refusal = await refuseSiteVisibilityWhileEnvironmentUnknown();

    expect(refusal?.status).toBe(409);
  });

  it("does not throw when the database is unreachable — it refuses", async () => {
    // `resolveEnvironmentRole` swallows the read failure and answers UNKNOWN, so
    // the gate needs no error handling of its own. Pinned because a caller that
    // wrapped this in a try/catch and CONTINUED on error would invert it.
    declareEnvironmentRole("production");
    mockFindUnique.mockRejectedValue(new Error("connection refused"));

    await expect(
      refuseSiteVisibilityWhileEnvironmentUnknown(),
    ).resolves.not.toBeNull();
  });

  it("names all THREE repairs, the invariant, and no secrets", async () => {
    undeclareEnvironmentRole();

    const refusal = await refuseSiteVisibilityWhileEnvironmentUnknown();
    const body = (await refusal?.json()) as { error: string };

    expect(body.error).toContain("APP_ENVIRONMENT_ROLE");
    expect(body.error).toContain("Admin › Environment");
    expect(body.error).toContain("nothing was changed");
    // THE THIRD CAUSE HAS ITS OWN REPAIR, and it is the one an operator cannot
    // guess. UNKNOWN also covers "the safer override could not be read" — an
    // un-migrated database or one refusing the query — which is reachable on an
    // installation that is otherwise serving and is fixed by neither of the
    // other two. A message naming only those two sends somebody who has already
    // set the variable correctly back to check the thing that is not wrong.
    expect(body.error).toContain("prisma migrate deploy");
    expect(body.error).toContain("restore database access");
    // AGENTS.md: a guard names the id it enforces in its failure message, as
    // `INV-CONFIG-005`'s Xero refusals do.
    expect(body.error).toContain("INV-CONFIG-006");
    // Secret-free by construction: it names a variable, a screen and a migration
    // command, never a value, a connection string or a provider identifier.
    expect(body.error).not.toMatch(/postgres|password|sk_|whsec_|Bearer/i);
  });

  it("gives the SAME message to the unreadable-override case it now names", async () => {
    // The three causes share one message on purpose — the resolver collapses
    // them to one answer and the gate follows it — so this pins that the case
    // the third repair was written for really does receive that repair, rather
    // than the wording being true only of the undeclared case above.
    declareEnvironmentRole("production");
    mockFindUnique.mockRejectedValue(new Error("relation does not exist"));

    const refusal = await refuseSiteVisibilityWhileEnvironmentUnknown();
    const body = (await refusal?.json()) as { error: string };

    expect(body.error).toBe(SITE_VISIBILITY_UNKNOWN_ROLE_ERROR);
    expect(body.error).toContain("prisma migrate deploy");
  });
});
