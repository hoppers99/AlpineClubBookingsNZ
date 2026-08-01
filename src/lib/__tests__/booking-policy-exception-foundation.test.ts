import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HARD_STOP_BOOKING_FAILURE_CODES,
  POLICY_EXCEPTION_REASON_CODES,
  aggregatePolicyExceptionViolations,
  isHardStopBookingFailureCode,
  isPolicyExceptionReasonCode,
  type MinimumStayPolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
import {
  lockMinimumStayPolicyScopes,
  minimumStayPolicyScopeKey,
} from "@/lib/minimum-stay-policy-set";
import { getMinimumStayViolations } from "@/lib/policies/minimum-stay";

const MIGRATION =
  "20260801190000_add_booking_policy_exception_foundation";

function repoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function violation(
  policyId: string,
  capacityMode: "HOLD" | "NO_HOLD",
): MinimumStayPolicyExceptionViolation {
  return {
    reasonCode: "MINIMUM_STAY",
    policyId,
    policyVersion: 3,
    policyName: `Policy ${policyId}`,
    resolvedScope: {
      kind: "LODGE",
      lodgeId: "lodge-1",
      effectiveLodgeId: "lodge-1",
    },
    affectedNights: ["2026-07-04"],
    exceptionEligible: true,
    capacityMode,
    message: "A minimum-stay exception is required.",
    triggerDay: "Saturday",
    minimumNights: 2,
    actualNights: 1,
    requirements: {
      kind: "MINIMUM_STAY",
      minimumNights: 2,
      actualNights: 1,
      triggerDays: [6],
    },
  };
}

describe("booking-policy exception registry (#2363)", () => {
  it("is a closed two-reason soft-policy allowlist disjoint from hard stops", () => {
    expect(POLICY_EXCEPTION_REASON_CODES).toEqual([
      "MINIMUM_STAY",
      "ADULT_MEMBER_HOSTING_REQUIRED",
    ]);
    expect(new Set(POLICY_EXCEPTION_REASON_CODES).size).toBe(2);
    for (const code of HARD_STOP_BOOKING_FAILURE_CODES) {
      expect(isHardStopBookingFailureCode(code)).toBe(true);
      expect(isPolicyExceptionReasonCode(code)).toBe(false);
    }
    expect(isPolicyExceptionReasonCode("CAPACITY_EXCEEDED")).toBe(false);
    expect(isPolicyExceptionReasonCode("MINIMUM_STAY")).toBe(true);
  });

  it("freezes exact date-only nights, policy identity/version and scope", () => {
    const result = getMinimumStayViolations(
      new Date("2026-07-03T00:00:00.000Z"),
      new Date("2026-07-05T00:00:00.000Z"),
      [
        {
          id: "policy-9",
          version: 7,
          name: "Friday and Saturday",
          startDate: new Date("2026-06-01T00:00:00.000Z"),
          endDate: new Date("2026-09-30T00:00:00.000Z"),
          triggerDays: [6, 5, 6],
          minimumNights: 3,
          lodgeId: null,
          capacityMode: "NO_HOLD",
        },
      ],
      "lodge-2",
    );

    expect(result).toEqual([
      expect.objectContaining({
        reasonCode: "MINIMUM_STAY",
        policyId: "policy-9",
        policyVersion: 7,
        resolvedScope: {
          kind: "CLUB_WIDE",
          lodgeId: null,
          effectiveLodgeId: "lodge-2",
        },
        affectedNights: ["2026-07-03", "2026-07-04"],
        capacityMode: "NO_HOLD",
        exceptionEligible: true,
        requirements: {
          kind: "MINIMUM_STAY",
          minimumNights: 3,
          actualNights: 2,
          triggerDays: [5, 6],
        },
      }),
    ]);
  });

  it("orders deterministically and applies HOLD-wins aggregation", () => {
    expect(
      aggregatePolicyExceptionViolations([
        violation("z-policy", "NO_HOLD"),
        violation("a-policy", "HOLD"),
      ]),
    ).toEqual({
      capacityMode: "HOLD",
      violations: [violation("a-policy", "HOLD"), violation("z-policy", "NO_HOLD")],
    });
    expect(aggregatePolicyExceptionViolations([])).toEqual({
      capacityMode: null,
      violations: [],
    });
  });
});

describe("minimum-stay policy write contract (#2363)", () => {
  it("uses DB defaults only to bridge the draining old colour", () => {
    const migration = repoFile(
      `prisma/migrations/${MIGRATION}/migration.sql`,
    );
    const ledger = repoFile("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv");
    const row = ledger
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${MIGRATION}\t`));

    expect(migration).toContain(
      'ADD COLUMN "capacityMode" "PolicyExceptionCapacityMode" NOT NULL DEFAULT \'HOLD\'',
    );
    expect(migration).toContain(
      'ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1',
    );
    expect(row).toContain("draining pre-#2363 colour");
    expect(row).toContain("new runtime requires capacityMode");
    expect(row).toContain("never relies on the DB default");
  });

  it("requires new-runtime creates to submit capacityMode explicitly", () => {
    const route = repoFile(
      "src/app/api/admin/booking-policies/minimum-stay/route.ts",
    );
    expect(route).toContain(
      'capacityMode: z.enum(["HOLD", "NO_HOLD"]),',
    );
    expect(route).not.toMatch(
      /capacityMode:\s*z\.enum\(\["HOLD", "NO_HOLD"\]\)\.(?:default|optional)/,
    );
    expect(route).toContain("capacityMode: data.capacityMode");
    expect(route).not.toContain("capacityMode: data.capacityMode ??");
  });

  it("derives and acquires shared scope locks in stable order", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = { $executeRaw: executeRaw };

    await lockMinimumStayPolicyScopes(
      tx as Parameters<typeof lockMinimumStayPolicyScopes>[0],
      ["lodge-z", null, "lodge-a", "lodge-z"],
    );

    expect(minimumStayPolicyScopeKey(null)).toBe("club-wide");
    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(executeRaw.mock.calls.map((call) => call[1])).toEqual([
      "minimum-stay-policy-set:club-wide",
      "minimum-stay-policy-set:lodge-a",
      "minimum-stay-policy-set:lodge-z",
    ]);
  });
});
