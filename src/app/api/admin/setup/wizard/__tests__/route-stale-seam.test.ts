import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    setupProgress: { findUnique: (...args: unknown[]) => mockFindUnique(...args) },
  },
}));

vi.mock("@/lib/setup-readiness-db", () => ({
  getSetupDatabaseSnapshot: async () => ({ adminModuleSettings: undefined }),
}));

vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: async () => ({ isComplete: false }),
}));

vi.mock("@/lib/setup-readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-readiness")>();
  return { ...actual, buildSetupReadiness: () => ({ categories: [] }) };
});

const mockBuildTraversal = vi.fn();
vi.mock("@/lib/setup-wizard-traversal", async (importOriginal) => {
  // Partial, and the spy DELEGATES: the real traversal still computes the
  // response, so this file cannot pass while the route hands it something the
  // traversal would reject. The spy exists only to read the argument, which is
  // the whole point of the seam — `[]`, `undefined` and a stored list are three
  // different instructions that can produce the same output today, because no
  // real step declares a prerequisite yet.
  const actual =
    await importOriginal<typeof import("@/lib/setup-wizard-traversal")>();
  return {
    ...actual,
    buildSetupWizardTraversal: (input: unknown) => {
      mockBuildTraversal(input);
      return (
        actual.buildSetupWizardTraversal as (arg: unknown) => unknown
      )(input);
    },
  };
});

import { GET } from "@/app/api/admin/setup/wizard/route";

/**
 * C4's seam, closed (epic #213, C2/#217).
 *
 * The wizard read used to DERIVE the stale set on every request. It now reads
 * what the last progress write computed and stored — except when there is
 * nothing trustworthy to read, where it must fall back to derivation rather
 * than invent an empty answer. `[]` and `undefined` are different instructions
 * (`[]` means "computed: nothing is stale"), so what is asserted here is which
 * of the two the route passed, not the response it produced.
 */

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "default",
    completedStepIds: [],
    skippedStepIds: [],
    staleStepIds: [],
    completedAt: null,
    completedByMemberId: null,
    ...overrides,
  };
}

function suppliedStaleStepIds() {
  expect(mockBuildTraversal).toHaveBeenCalledTimes(1);
  return (mockBuildTraversal.mock.calls[0][0] as { staleStepIds?: unknown })
    .staleStepIds;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true as const,
    session: { user: { id: "admin1" } },
  });
  mockFindUnique.mockResolvedValue(storedRow());
});

describe("GET /api/admin/setup/wizard — the stale seam (#217)", () => {
  it("passes the stored set through rather than deriving it", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({
        completedStepIds: ["stripe", "age-tiers"],
        staleStepIds: ["stripe", "age-tiers"],
      }),
    );

    const response = await GET();
    expect(response.status).toBe(200);
    expect(suppliedStaleStepIds()).toEqual(["stripe", "age-tiers"]);
  });

  it("passes a stored EMPTY set as [], which means computed-nothing-stale", async () => {
    await GET();
    expect(suppliedStaleStepIds()).toEqual([]);
  });

  it("falls back to derivation when there is no progress row at all", async () => {
    mockFindUnique.mockResolvedValue(null);
    await GET();
    expect(suppliedStaleStepIds()).toBeUndefined();
  });

  it("falls back to derivation when the stored column cannot be trusted", async () => {
    mockFindUnique.mockResolvedValue(storedRow({ staleStepIds: "stripe" }));
    await GET();
    expect(suppliedStaleStepIds()).toBeUndefined();
  });

  it("keeps the admin guard ahead of every read", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockBuildTraversal).not.toHaveBeenCalled();
  });
});
