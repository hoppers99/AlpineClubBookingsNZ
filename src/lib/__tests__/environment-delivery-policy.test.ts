import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The delivery policy itself (ENV-SAFETY 2, #3035; epic #2986; INV-CONFIG-004).
 *
 * Three answers, and the whole issue is that they stay three: allow, a confirmed
 * copy suppressing, and an unconfirmed installation failing closed. Everything
 * downstream — the EmailLog status, the retry cron's behaviour, whether a Xero
 * sync operation reports PARTIAL — is keyed on which of the three this module
 * returns, so this is where the mapping is pinned.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { environmentSafetySettings: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import {
  assertDeliveryClearanceWitness,
  decideDeliveryPolicy,
  describeDeliveryDecision,
  DeliveryClearanceError,
  requireProductionDeliveryClearance,
  resolveDeliveryPolicy,
  type DeliveryClearance,
} from "@/lib/environment-delivery-policy";
import { decideEnvironmentRole } from "@/lib/environment-role";
import { environmentRoleDeclaration } from "@/lib/__tests__/helpers/environment-role";

const NO_OVERRIDE = { kind: "none" } as const;
const UNREADABLE_OVERRIDE = { kind: "unreadable" } as const;
const FORCED_OVERRIDE = {
  kind: "force-non-production",
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedByMemberId: "m_1",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.findUnique.mockResolvedValue(null);
});

describe("decideDeliveryPolicy (INV-CONFIG-004)", () => {
  it("allows delivery, with a clearance, only for a declared production installation", () => {
    const decision = decideDeliveryPolicy(
      decideEnvironmentRole(environmentRoleDeclaration.production, NO_OVERRIDE),
    );
    expect(decision.kind).toBe("allow");
    // The clearance is a real value, not a type-level fiction: the runtime
    // witness check has to accept it.
    if (decision.kind !== "allow") throw new Error("unreachable");
    expect(() =>
      assertDeliveryClearanceWitness(decision.clearance),
    ).not.toThrow();
  });

  it("suppresses for a declared copy, and says the DEPLOYMENT decided", () => {
    expect(
      decideDeliveryPolicy(
        decideEnvironmentRole(
          environmentRoleDeclaration.nonProduction,
          NO_OVERRIDE,
        ),
      ),
    ).toEqual({
      kind: "suppress_non_production",
      decidedBy: "deployment-declaration",
    });
  });

  it("suppresses for an administrator-forced copy, and says the DATABASE decided", () => {
    /*
      The two suppression sources are kept apart because the remedy differs: a
      declared copy is behaving as its deployment says, while a forced one has a
      switch somebody can turn off on the admin screen. The operator sentence
      names that screen only in this case.
    */
    const decision = decideDeliveryPolicy(
      decideEnvironmentRole(
        environmentRoleDeclaration.production,
        FORCED_OVERRIDE,
      ),
    );
    expect(decision).toEqual({
      kind: "suppress_non_production",
      decidedBy: "database-safer-override",
    });
    expect(describeDeliveryDecision(decision)).toContain("safer override");
  });

  it("blocks an unreadable override BEFORE it reads the declaration, even a production one", () => {
    /*
      Branch order, and it is load-bearing rather than cosmetic. An unreadable
      override resolves UNKNOWN even under a declared `production`, so if this
      module checked the declaration first it would tell an operator who has set
      the variable correctly to go and set the variable — sending them to fix the
      one thing that is already right, while the database is the real fault.
    */
    expect(
      decideDeliveryPolicy(
        decideEnvironmentRole(
          environmentRoleDeclaration.production,
          UNREADABLE_OVERRIDE,
        ),
      ),
    ).toEqual({
      kind: "block_environment_unknown",
      reason: "override_unreadable",
    });
  });

  it("tells a missing declaration apart from one it refuses to interpret", () => {
    expect(
      decideDeliveryPolicy(
        decideEnvironmentRole(environmentRoleDeclaration.absent, NO_OVERRIDE),
      ),
    ).toEqual({
      kind: "block_environment_unknown",
      reason: "declaration_missing",
    });
    expect(
      decideDeliveryPolicy(
        decideEnvironmentRole(environmentRoleDeclaration.invalid, NO_OVERRIDE),
      ),
    ).toEqual({
      kind: "block_environment_unknown",
      reason: "declaration_invalid",
    });
  });
});

describe("describeDeliveryDecision", () => {
  it("gives each outcome its own operator sentence, and repeats no reused wording", () => {
    const sentences = [
      describeDeliveryDecision(
        decideDeliveryPolicy(
          decideEnvironmentRole(
            environmentRoleDeclaration.nonProduction,
            NO_OVERRIDE,
          ),
        ),
      ),
      describeDeliveryDecision(
        decideDeliveryPolicy(
          decideEnvironmentRole(
            environmentRoleDeclaration.production,
            UNREADABLE_OVERRIDE,
          ),
        ),
      ),
      describeDeliveryDecision(
        decideDeliveryPolicy(
          decideEnvironmentRole(environmentRoleDeclaration.absent, NO_OVERRIDE),
        ),
      ),
      describeDeliveryDecision(
        decideDeliveryPolicy(
          decideEnvironmentRole(environmentRoleDeclaration.invalid, NO_OVERRIDE),
        ),
      ),
    ];
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) {
      // Every one says what did NOT happen, so a reader of an old log row is not
      // left wondering whether a member got the message.
      expect(sentence).toContain("no provider was contacted");
    }
    // The repair for a missing declaration names the variable, and names the
    // one an operator will otherwise reach for by mistake.
    expect(sentences[2]).toContain("APP_ENVIRONMENT_ROLE");
    expect(sentences[2]).toContain("APP_RUNTIME_ROLE");
    // A refused VALUE is never echoed into an operator sentence from here — the
    // declaration parser has its own capped, sanitized display for that.
    expect(sentences[3]).not.toContain("staging");
  });
});

describe("the clearance token", () => {
  it("refuses a forged or cast token, so the type escape hatch fails closed", async () => {
    /*
      `{} as unknown as DeliveryClearance` type-checks — TypeScript's brand is
      erased at runtime. This is the check that makes the cast useless, and it is
      the reason the source census over `as ... DeliveryClearance` is a second
      line of defence rather than the only one.
    */
    for (const forged of [
      {} as unknown as DeliveryClearance,
      null as unknown as DeliveryClearance,
      "production-confirmed" as unknown as DeliveryClearance,
      { "production-confirmed": true } as unknown as DeliveryClearance,
    ]) {
      expect(() => assertDeliveryClearanceWitness(forged)).toThrow(
        DeliveryClearanceError,
      );
      await expect(requireProductionDeliveryClearance(forged)).rejects.toThrow(
        DeliveryClearanceError,
      );
    }
  });

  it("does not survive a round trip through JSON", () => {
    // The witness is a symbol, so a clearance cannot be smuggled through a queue
    // payload, a cache or a request body and re-presented later.
    const decision = decideDeliveryPolicy(
      decideEnvironmentRole(environmentRoleDeclaration.production, NO_OVERRIDE),
    );
    if (decision.kind !== "allow") throw new Error("unreachable");
    const revived = JSON.parse(
      JSON.stringify(decision.clearance),
    ) as DeliveryClearance;
    expect(() => assertDeliveryClearanceWitness(revived)).toThrow(
      DeliveryClearanceError,
    );
  });

  it("refuses a genuine clearance once an administrator forces the copy mid-flight", async () => {
    /*
      The case the second half of the runtime check exists for. A batch can hold a
      clearance minted minutes ago; the click that switches the safer override on
      is the one somebody makes when they have just realised a copy is about to
      email real members, and it has to take effect on the messages still in
      flight.
    */
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "production");
    const allowed = await resolveDeliveryPolicy();
    expect(allowed.kind).toBe("allow");
    if (allowed.kind !== "allow") throw new Error("unreachable");
    await expect(
      requireProductionDeliveryClearance(allowed.clearance),
    ).resolves.toBe("PRODUCTION");

    mocks.findUnique.mockResolvedValue({
      forceNonProduction: true,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedByMemberId: "m_1",
    });
    await expect(
      requireProductionDeliveryClearance(allowed.clearance),
    ).rejects.toThrow(/no longer confirmed production/);
  });
});

describe("resolveDeliveryPolicy over the live resolution", () => {
  it("fails closed when nothing has declared this installation", async () => {
    expect(await resolveDeliveryPolicy()).toEqual({
      kind: "block_environment_unknown",
      reason: "declaration_missing",
    });
  });

  it("fails closed when the override cannot be read at all", async () => {
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "production");
    mocks.findUnique.mockRejectedValue(new Error("relation does not exist"));
    expect(await resolveDeliveryPolicy()).toEqual({
      kind: "block_environment_unknown",
      reason: "override_unreadable",
    });
  });

  it("suppresses on a declared copy without needing the database at all", async () => {
    /*
      A declared copy is already the safest answer, so a database blip cannot move
      it — which matters because a copy is exactly where somebody is likely to be
      running against a half-migrated database.
    */
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "non-production");
    mocks.findUnique.mockRejectedValue(new Error("relation does not exist"));
    expect(await resolveDeliveryPolicy()).toEqual({
      kind: "suppress_non_production",
      decidedBy: "deployment-declaration",
    });
  });
});
