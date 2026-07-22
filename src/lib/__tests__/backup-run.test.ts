import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    backupRun: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
      backupRun: {
        findUnique: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
    },
    runDatabaseBackup: vi.fn(),
    logger: { error: vi.fn(), info: vi.fn() },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/backup", () => ({
  runDatabaseBackup: mocks.runDatabaseBackup,
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { runManagedBackup } from "@/lib/backup-run";

describe("runManagedBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.backupRun.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.backupRun.findFirst.mockResolvedValue(null);
    mocks.tx.backupRun.create.mockResolvedValue({ id: "run-1" });
    mocks.prisma.backupRun.findUnique.mockResolvedValue({
      startedAt: new Date(Date.now() - 1000),
    });
    mocks.prisma.backupRun.update.mockResolvedValue({});
  });

  it("claims the lock, runs the backup, and finalizes SUCCESS", async () => {
    mocks.runDatabaseBackup.mockResolvedValue({
      success: true,
      filename: "b.sql.gz",
      sizeBytes: 1024,
      uploadedToS3: true,
    });

    const outcome = await runManagedBackup({ trigger: "manual" });

    // Serialised across processes via the advisory lock inside the claim txn.
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.tx.backupRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RUNNING", trigger: "manual" }),
      }),
    );
    expect(mocks.runDatabaseBackup).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.backupRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({ status: "SUCCESS" }),
      }),
    );
    expect(outcome.claimed).toBe(true);
  });

  it("refuses to run when another process already holds an active run", async () => {
    mocks.tx.backupRun.findFirst.mockResolvedValue({ id: "other-run" });

    const outcome = await runManagedBackup({ trigger: "scheduled" });

    expect(outcome.claimed).toBe(false);
    expect(mocks.tx.backupRun.create).not.toHaveBeenCalled();
    expect(mocks.runDatabaseBackup).not.toHaveBeenCalled();
  });

  it("reaps stale RUNNING rows before claiming", async () => {
    mocks.runDatabaseBackup.mockResolvedValue({ success: true, uploadedToS3: true });

    await runManagedBackup({ trigger: "scheduled" });

    expect(mocks.tx.backupRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "RUNNING",
          heartbeatAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
        data: expect.objectContaining({ status: "FAILURE" }),
      }),
    );
  });

  it("finalizes FAILURE when the backup engine reports failure", async () => {
    mocks.runDatabaseBackup.mockResolvedValue({
      success: false,
      error: "pg_dump failed: boom",
    });

    const outcome = await runManagedBackup({ trigger: "scheduled" });

    expect(outcome.claimed).toBe(true);
    expect(mocks.prisma.backupRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILURE",
          error: "pg_dump failed: boom",
        }),
      }),
    );
  });

  it("finalizes SKIPPED when the backup is disabled", async () => {
    mocks.runDatabaseBackup.mockResolvedValue({
      success: false,
      skipped: true,
      reason: "Backups are disabled. Enable them on Admin → Backups.",
    });

    const outcome = await runManagedBackup({ trigger: "scheduled" });

    expect(outcome.claimed).toBe(true);
    expect(mocks.prisma.backupRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED" }),
      }),
    );
  });

  it("finalizes FAILURE and rethrows when the backup engine throws", async () => {
    mocks.runDatabaseBackup.mockRejectedValue(new Error("kaboom"));

    await expect(runManagedBackup({ trigger: "manual" })).rejects.toThrow(
      "kaboom",
    );
    expect(mocks.prisma.backupRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILURE" }),
      }),
    );
  });
});
