import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindUnique = vi.fn();
const mockEmailLogAggregate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // The delegate is present, so its ANSWER is what decides the override rather
    // than its absence. A missing delegate is `unreadable` (and therefore
    // UNKNOWN) — the default state of almost every suite in this repository, and
    // a case with its own test below.
    environmentSafetySettings: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
    // `readWithheldApplicationEmail()`'s three aggregates (suppressed, blocked,
    // captureInProduction, in that call order — see its own module). Defaulted
    // to "nothing withheld" in `beforeEach` below, so every test reaches the
    // role branch it means to; the capture-in-production test overrides the
    // third call specifically.
    emailLog: {
      aggregate: (...args: unknown[]) => mockEmailLogAggregate(...args),
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
import { stubHealthyLaunchGateEnv } from "@/lib/__tests__/helpers/setup-launch-gate";
import {
  SITE_VISIBILITY_UNKNOWN_ROLE_ERROR,
  refuseSiteVisibilityWhileLaunchBlocked,
} from "@/lib/site-visibility-gate";

/**
 * The launch gate on publishing the public site — `INV-CONFIG-006` (epic
 * #213, C16/#247; widened to all three registry `launchGate:
 * "blocks-until-complete"` facts by C15's fix round on the same issue, per
 * D17 review finding F4).
 *
 * What is worth testing is not the branch but the POLARITY per fact, plus the
 * ORDERING between facts — the part a well-meaning refactor breaks. Every
 * case below goes through the REAL `resolveEnvironmentRole`,
 * `readWithheldApplicationEmail`, `buildRuntimeEnvCheck` and
 * `buildAuthSecretStrengthCheck`, driven by the sources they actually read
 * (the role resolver's two sources, the `emailLog` aggregates, and
 * `process.env`), so a change to any of their own polarity shows up here
 * rather than being hidden behind a stubbed check result.
 *
 * `stubHealthyLaunchGateEnv()` in `beforeEach` gives every test a
 * publishable `runtime-env` and `auth-secret-strength` by default — see
 * `src/lib/__tests__/helpers/setup-launch-gate.ts` — so a test only has to
 * disturb the ONE fact it means to test.
 */

beforeEach(() => {
  vi.clearAllMocks();
  // No override, which is the ordinary state of an installation that has never
  // used the safer switch.
  mockFindUnique.mockResolvedValue(null);
  // Nothing withheld, on all three aggregates — the ordinary state of an
  // installation whose mail is flowing normally.
  mockEmailLogAggregate.mockResolvedValue({
    _count: { _all: 0 },
    _max: { createdAt: null },
  });
  stubHealthyLaunchGateEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("refuseSiteVisibilityWhileLaunchBlocked (#247, D17)", () => {
  describe("environment-role", () => {
    it("lets a declared production installation publish", async () => {
      declareEnvironmentRole("production");
      await expect(refuseSiteVisibilityWhileLaunchBlocked()).resolves.toBeNull();
    });

    it("lets a declared NON-PRODUCTION installation publish too", async () => {
      // Deliberate, and not an oversight: an internal staging site is legitimately
      // visible and non-production forever. This is the precise form of D9's "two
      // independent levers" that survives #247 — the levers are independent of
      // each other's ANSWER, never of there being one — and a gate that refused
      // here would break the half of the claim that is still true.
      declareEnvironmentRole("non-production");
      await expect(refuseSiteVisibilityWhileLaunchBlocked()).resolves.toBeNull();
    });

    it("lets a production installation forced safer by an administrator publish", async () => {
      declareEnvironmentRole("production");
      mockFindUnique.mockResolvedValue({
        forceNonProduction: true,
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedByMemberId: "admin1",
      });
      await expect(refuseSiteVisibilityWhileLaunchBlocked()).resolves.toBeNull();
    });

    it("refuses when nothing has declared this installation", async () => {
      undeclareEnvironmentRole();

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();

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

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();

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

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();

      expect(refusal?.status).toBe(409);
    });

    it("does not throw when the database is unreachable — it refuses", async () => {
      // `resolveEnvironmentRole` swallows the read failure and answers UNKNOWN, so
      // the gate needs no error handling of its own. Pinned because a caller that
      // wrapped this in a try/catch and CONTINUED on error would invert it.
      declareEnvironmentRole("production");
      mockFindUnique.mockRejectedValue(new Error("connection refused"));

      await expect(
        refuseSiteVisibilityWhileLaunchBlocked(),
      ).resolves.not.toBeNull();
    });

    it("names all THREE repairs, the invariant, and no secrets", async () => {
      undeclareEnvironmentRole();

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();
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

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();
      const body = (await refusal?.json()) as { error: string };

      expect(body.error).toBe(SITE_VISIBILITY_UNKNOWN_ROLE_ERROR);
      expect(body.error).toContain("prisma migrate deploy");
    });

    it("refuses a DECLARED PRODUCTION that is also capturing its own mail, with the STATUS-AWARE remedy rather than the UNKNOWN one (#3035)", async () => {
      // The fourth cause under `environment-role`, and the reason this fact is
      // NOT reducible to "role === UNKNOWN": the role is correctly declared
      // here, so telling the operator to set APP_ENVIRONMENT_ROLE — the
      // UNKNOWN message's whole repair — sends them to check a variable that
      // is already right. `resolveEnvironmentRemedy`'s status-aware override
      // (`SETUP_ENVIRONMENT_REMEDY_BY_STATUS["environment-role"]["warning"]`)
      // exists for exactly this branch, and this gate must reuse it rather
      // than falling back to the base (UNKNOWN) entry.
      declareEnvironmentRole("production");
      // Third call is `captureInProduction` — see the mock's own call-order
      // comment above.
      mockEmailLogAggregate
        .mockResolvedValueOnce({ _count: { _all: 0 }, _max: { createdAt: null } })
        .mockResolvedValueOnce({ _count: { _all: 3 }, _max: { createdAt: new Date("2026-06-15T00:00:00.000Z") } })
        .mockResolvedValueOnce({ _count: { _all: 3 } });

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();
      const body = (await refusal?.json()) as { error: string };

      expect(refusal?.status).toBe(409);
      // NOT the UNKNOWN-role message — the role IS declared and correct here.
      expect(body.error).not.toBe(SITE_VISIBILITY_UNKNOWN_ROLE_ERROR);
      expect(body.error).not.toContain(
        "has not been confirmed as production or non-production",
      );
      // The status-aware remedy's own `send` line, reused verbatim.
      expect(body.error).toContain("USE_LOCAL_CAPTURE");
      expect(body.error).toContain("INV-CONFIG-006");
    });
  });

  describe("runtime-env", () => {
    it("refuses while a required runtime variable is missing, naming its own remedy", async () => {
      declareEnvironmentRole("production");
      vi.stubEnv("CRON_SECRET", "");

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();
      const body = (await refusal?.json()) as { error: string };

      expect(refusal?.status).toBe(409);
      expect(body.error).toContain("nothing was changed");
      // The runtime-env remedy's own `send` line — reused verbatim from
      // `SETUP_ENVIRONMENT_REMEDY["runtime-env"]` rather than a second
      // hand-written sentence, so the panel and this 409 can never disagree.
      expect(body.error).toContain(
        "One or more required variables are missing or malformed",
      );
      expect(body.error).toContain("INV-CONFIG-006");
      // NOT the role message — this is a different fact with a different repair.
      expect(body.error).not.toBe(SITE_VISIBILITY_UNKNOWN_ROLE_ERROR);
      expect(body.error).not.toMatch(/postgres|password|sk_|whsec_|Bearer/i);
    });

    it("points at the setup wizard's About this server panel, not Admin › Environment", async () => {
      // `runtime-env` and `auth-secret-strength` are reported on the wizard's
      // own panel (D17, #246) rather than `/admin/environment`, which is
      // `environment-role`'s dedicated page. Naming the wrong screen sends an
      // operator looking in a place that has nothing to show them.
      declareEnvironmentRole("production");
      vi.stubEnv("DATABASE_URL", "");

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();
      const body = (await refusal?.json()) as { error: string };

      expect(body.error).toContain("About this server");
      expect(body.error).not.toContain("Admin › Environment");
    });
  });

  describe("auth-secret-strength", () => {
    it("refuses while the auth secret is too short, naming its own remedy", async () => {
      declareEnvironmentRole("production");
      // Present (so `runtime-env`'s own AUTH_SECRET-or-NEXTAUTH_SECRET check
      // stays green — see that check's docblock) but under the 32-character
      // floor, which is what `auth-secret-strength` alone catches.
      vi.stubEnv("AUTH_SECRET", "too-short");

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();
      const body = (await refusal?.json()) as { error: string };

      expect(refusal?.status).toBe(409);
      expect(body.error).toContain("nothing was changed");
      // The auth-secret-strength remedy's own `send` line, reused verbatim.
      expect(body.error).toContain("openssl rand -base64 48");
      expect(body.error).toContain("INV-CONFIG-006");
      expect(body.error).not.toBe(SITE_VISIBILITY_UNKNOWN_ROLE_ERROR);
      expect(body.error).not.toMatch(/postgres|password|sk_|whsec_|Bearer/i);
    });

    it("refuses on the shipped .env.example placeholder too", async () => {
      declareEnvironmentRole("production");
      vi.stubEnv("AUTH_SECRET", "your-secret-key-here-change-in-production");

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();

      expect(refusal?.status).toBe(409);
    });
  });

  describe("precedence — deterministic, environment-role first, then runtime-env, then auth-secret-strength", () => {
    it("reports environment-role's own refusal when BOTH the role and the runtime environment are broken", async () => {
      undeclareEnvironmentRole();
      vi.stubEnv("CRON_SECRET", "");

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();
      const body = (await refusal?.json()) as { error: string };

      // Role answers FIRST: nothing about a deployment's runtime contract is
      // worth reporting to an operator who does not yet know whether this
      // installation is the club's live site or a copy.
      expect(body.error).toBe(SITE_VISIBILITY_UNKNOWN_ROLE_ERROR);
    });

    it("reports runtime-env's own refusal when BOTH runtime-env and the auth secret are broken, once the role is fine", async () => {
      declareEnvironmentRole("production");
      vi.stubEnv("CRON_SECRET", "");
      vi.stubEnv("AUTH_SECRET", "too-short");

      const refusal = await refuseSiteVisibilityWhileLaunchBlocked();
      const body = (await refusal?.json()) as { error: string };

      expect(body.error).toContain(
        "One or more required variables are missing or malformed",
      );
      expect(body.error).not.toContain("openssl rand -base64 48");
    });

    it("all three green publishes", async () => {
      declareEnvironmentRole("production");
      // `stubHealthyLaunchGateEnv()` in `beforeEach` already supplies a
      // complete runtime environment and a strong auth secret — this test
      // exists to say so explicitly, as the precedence tests' contrast.
      await expect(refuseSiteVisibilityWhileLaunchBlocked()).resolves.toBeNull();
    });
  });
});
