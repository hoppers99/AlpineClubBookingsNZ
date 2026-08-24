import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    setupProgress: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

// C2 (#217) made the route recompute the stale set on every write. That
// computation has its own tests (`setup-progress-staleness.test.ts`) and its own
// route-level tests (`route-stale-state.test.ts`); stubbing it to "nothing is
// stale" here keeps THIS file about the five transition event types, and pins
// that an ordinary transition still writes exactly one audit row.
const mockRecomputeSetupStaleStepIds = vi.fn();
vi.mock("@/lib/setup-progress-staleness", () => ({
  recomputeSetupStaleStepIds: (...args: unknown[]) =>
    mockRecomputeSetupStaleStepIds(...args),
}));

import { PATCH } from "@/app/api/admin/setup/progress/route";

/**
 * What the setup-progress route records (epic #213, C4/#219).
 *
 * The transitions were already audited before this change; what they were not
 * was DISTINGUISHABLE. Every one wrote `setup_progress.update`, and
 * `AuditLog.action` is what the audit log's Event Type filter selects on, so
 * "who deferred a step" was not a question the log could answer. These tests
 * pin one action per transition, and pin the category at `system` so a later
 * lane cannot quietly move these rows to a different audience
 * (`INV-PRIV-012` / `INV-OPS-012`).
 */

function patch(body: unknown) {
  return new NextRequest("http://localhost/api/admin/setup/progress", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function auditCall() {
  expect(mockLogAudit).toHaveBeenCalledTimes(1);
  return mockLogAudit.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true as const,
    session: { user: { id: "admin1" } },
  });
  mockRecomputeSetupStaleStepIds.mockResolvedValue([]);
  mockFindUnique.mockResolvedValue({
    id: "default",
    completedStepIds: [],
    skippedStepIds: [],
    staleStepIds: [],
    completedAt: null,
    completedByMemberId: null,
  });
  mockUpsert.mockImplementation(async (args: { update: Record<string, unknown> }) => ({
    id: "default",
    completedStepIds: [],
    skippedStepIds: [],
    staleStepIds: [],
    completedAt: null,
    completedByMemberId: null,
    ...args.update,
  }));
});

describe("PATCH /api/admin/setup/progress audit trail (#219)", () => {
  const cases: [string, unknown, string, string][] = [
    [
      "completing a step",
      { action: "complete", stepId: "stripe" },
      "setup_progress.step_completed",
      'Setup step "stripe" marked complete',
    ],
    [
      "deferring a step",
      { action: "skip", stepId: "sentry" },
      "setup_progress.step_deferred",
      'Setup step "sentry" deferred for now',
    ],
    [
      "reopening a step",
      { action: "reopen", stepId: "age-tiers" },
      "setup_progress.step_reopened",
      'Setup step "age-tiers" reopened',
    ],
    [
      "finishing setup",
      { action: "finish" },
      "setup_progress.finished",
      "Setup marked finished",
    ],
    [
      "resetting progress",
      { action: "reset" },
      "setup_progress.reset",
      "Setup progress reset",
    ],
  ];

  it.each(cases)(
    // `docs/guides/audit-log.md` puts "Setup, backups, platform-level events"
    // under `system`, and `INV-PRIV-012` files a row by affected domain. Moving
    // these to `admin` would change which rows an operator can correlate and
    // would owe a backfill under `INV-OPS-012`. This is the assertion that
    // makes that a deliberate decision rather than a drive-by edit: it reads
    // the RECORDED `category` off each of the five actual `logAudit` calls, not
    // the fixture table's own action-name prefixes (a prior version of this
    // file asserted `action.startsWith("setup_progress.")` against `cases`
    // itself, which is true by construction of the table and proves nothing
    // about what the route recorded).
    "records %s under its own event type and files it under system, never admin (INV-PRIV-012)",
    async (_label, body, action, summary) => {
      const response = await PATCH(patch(body));
      expect(response.status).toBe(200);
      expect(auditCall()).toMatchObject({
        action,
        summary,
        category: "system",
        memberId: "admin1",
        actorMemberId: "admin1",
        entityType: "SetupProgress",
        entityId: "default",
        metadata: body,
      });
    },
  );

  it("gives every transition a distinct event type", () => {
    const actions = cases.map(([, , action]) => action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("records nothing when the caller is not an administrator", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const response = await PATCH(patch({ action: "reset" }));
    expect(response.status).toBe(403);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("records nothing when the body is rejected", async () => {
    const response = await PATCH(patch({ action: "complete", stepId: "nope" }));
    expect(response.status).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
