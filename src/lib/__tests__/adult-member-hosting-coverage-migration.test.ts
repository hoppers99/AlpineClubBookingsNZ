import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { MIGRATION_GATE_TIMEOUT_MS } from "./helpers/migration-gate-timeouts";

const MIGRATION_NAME = "20260806010000_fence_hosting_coverage_delivery_claims";
const MIGRATION_RELATIVE_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const LEDGER_RELATIVE_PATH = "docs/BLUE_GREEN_MIGRATION_SAFETY.tsv";
const MIGRATION_PATH = path.resolve(
  process.cwd(),
  MIGRATION_RELATIVE_PATH,
);
const ROLLBACK_PATH = path.resolve(
  process.cwd(),
  "prisma/migrations",
  MIGRATION_NAME,
  "rollback.sql",
);
const LEDGER_PATH = path.resolve(
  process.cwd(),
  LEDGER_RELATIVE_PATH,
);

function validate(env: Record<string, string> = {}) {
  const validatorEnv = {
    MIGRATION_SAFETY_LEDGER: LEDGER_RELATIVE_PATH,
    ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "0",
    BLUE_GREEN_MIGRATION_OVERRIDE_REASON: "",
    BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "0",
    ...env,
  };
  const assignments = Object.entries(validatorEnv)
    .map(
      ([key, value]) =>
        `${key}='${value.replace(/'/g, `'"'"'`)}'`,
    )
    .join(" ");
  return spawnSync(
    "bash",
    [
      "-lc",
      `${assignments} ./scripts/validate-blue-green-migrations.sh ${MIGRATION_RELATIVE_PATH}`,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    },
  );
}

describe("hosting delivery fencing migration (#2596)", () => {
  it("pins the additive DDL but mixed-runtime protocol as windowed", () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    const ledgerRow = readFileSync(LEDGER_PATH, "utf8")
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${MIGRATION_NAME}\t`));

    expect(migration).toContain('ADD COLUMN "claimToken" VARCHAR(64)');
    expect(migration).toContain('ADD COLUMN "claimExpiresAt" TIMESTAMP(3)');
    expect(migration).toContain(
      'ADD COLUMN "ownerNotificationClaimToken" VARCHAR(64)',
    );
    expect(migration).not.toMatch(/\b(?:DROP|DELETE|UPDATE|INSERT)\b/i);

    expect(ledgerRow).toBeDefined();
    expect(ledgerRow!.split("\t")[3]).toBe("windowed");
    expect(ledgerRow).toContain("MIXED-RUNTIME PROTOCOL IS NOT COMPATIBLE");
    expect(ledgerRow).toContain("old worker can still select");
    expect(ledgerRow).toContain("BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1");
  });

  it("ships a no-op rollback that keeps schema and history for clean roll-forward", () => {
    const rollback = readFileSync(ROLLBACK_PATH, "utf8");
    const executable = rollback
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trimStart().startsWith("--"));

    expect(executable).toEqual([]);
    expect(rollback).toContain("INTENTIONALLY NO-OP");
    const demote = rollback.indexOf("demote the club-wide ENFORCED row");
    const queueProof = rollback.indexOf('FROM "HostingCoverageReevaluation"');
    const incidentProof = rollback.indexOf('FROM "HostingCoverageIncident"');
    const stopNew = rollback.indexOf("Only now stop the new web colour");
    expect(demote).toBeGreaterThan(-1);
    expect(queueProof).toBeGreaterThan(demote);
    expect(incidentProof).toBeGreaterThan(queueProof);
    expect(stopNew).toBeGreaterThan(incidentProof);
    expect(rollback).toContain("maximum attempt count or");
    expect(rollback).toContain("repeat all three proofs");
    expect(rollback).toContain("Leave those nullable");
    expect(rollback).toContain("applied migration-history row intact");
  });

  it("refuses ordinary blue-green and an unproved override, then accepts the stopped-old-runtime window", () => {
    const ordinary = validate();
    expect(ordinary.status).not.toBe(0);
    expect(ordinary.stderr).toContain("Ledger declares this migration windowed");
    expect(ordinary.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");

    const overrideWithoutStoppedWorkers = validate({
      ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
      BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
        "hosting claim protocol maintenance window",
    });
    expect(overrideWithoutStoppedWorkers.status).not.toBe(0);
    expect(overrideWithoutStoppedWorkers.stderr).toContain(
      "BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1",
    );

    const windowed = validate({
      ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
      BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
        "hosting claim protocol window; public traffic removed and old runtime stopped",
      BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "1",
    });
    expect(windowed.status, windowed.stderr).toBe(0);
    // #2806: three real shell-outs to the bash gate. Measured at ~4.0 s on a
    // Windows developer machine against Vitest's implicit 5 s default — 79% of
    // budget — and it duly failed under load. Same budget, same reasoning, as
    // the other suites that run these gates for real.
  }, MIGRATION_GATE_TIMEOUT_MS);

  it("threads the stopped-runtime acknowledgement through the deployment validator", () => {
    const deploy = readFileSync(
      path.resolve(process.cwd(), "scripts/run-production-blue-green-deploy.sh"),
      "utf8",
    );
    const coverage = readFileSync(
      path.resolve(process.cwd(), "scripts/check-migration-safety-coverage.sh"),
      "utf8",
    );

    expect(deploy.match(/BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED/g)?.length).toBeGreaterThanOrEqual(3);
    expect(coverage).toContain("BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1");
  });
});
