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

/*
  THE DERIVATION IS STUBBED HERE, and that is the layering rather than a
  shortcut. What the two sets contain for a given club is settled in
  `setup-progress-staleness.test.ts` against the real traversal — including the
  containment property this file's last test leans on. What the ROUTE does when
  handed them is this file's subject, and stating the sets directly is the only
  way to reach the combinations that matter, one of which the real derivation
  cannot produce at all.

  The end-to-end pairing — the gate firing on a set the real derivation really
  computed — is in `route-stale-state.test.ts`, which mocks the snapshot instead
  and runs the whole computation.
*/
const mockRecomputeSetupProgressDerivation = vi.fn();
vi.mock("@/lib/setup-progress-staleness", () => ({
  recomputeSetupProgressDerivation: (...args: unknown[]) =>
    mockRecomputeSetupProgressDerivation(...args),
}));

import { PATCH } from "@/app/api/admin/setup/progress/route";

/**
 * The server stops trusting the client about FINISH (epic #213, C16/#247).
 *
 * Before this, `PATCH { action: "finish" }` stamped `completedAt`
 * unconditionally, and the only thing that consulted the outstanding steps was a
 * `disabled` prop on the readiness page's button. A `curl`, a double-submit
 * racing a refetch, or a stale tab could therefore mark a half-built
 * installation complete — silencing the C10 nudge banner and telling
 * `config-transfer/bootstrap-import.ts` this installation had been set up.
 *
 * The gate mirrors the refusal already in this handler: a value the server can
 * compute to be untrue is not stored, the whole transition is refused, nothing
 * is written, nothing is recorded, and the operator is told what blocks them.
 */

function patch(body: unknown) {
  return new NextRequest("http://localhost/api/admin/setup/progress", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

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

function persisted() {
  expect(mockUpsert).toHaveBeenCalledTimes(1);
  return mockUpsert.mock.calls[0][0].update as Record<string, unknown>;
}

/** Whatever the derivation says this club's two sets are. */
function derivation(
  staleStepIds: string[],
  blockingStepIds: string[],
) {
  mockRecomputeSetupProgressDerivation.mockResolvedValue({
    staleStepIds,
    blockingStepIds,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true as const,
    session: { user: { id: "admin1" } },
  });
  mockFindUnique.mockResolvedValue(storedRow());
  mockUpsert.mockImplementation(
    async (args: { update: Record<string, unknown> }) => ({
      ...storedRow(),
      ...args.update,
    }),
  );
  derivation([], []);
});

describe("PATCH /api/admin/setup/progress — the finish gate (#247)", () => {
  it("refuses a finish while blocking steps remain, and writes nothing", async () => {
    derivation([], ["club-config", "lodges"]);

    const response = await PATCH(patch({ action: "finish" }));

    expect(response.status).toBe(409);
    // The no-write refusal shape #217 settled for the 503 beside it: the row is
    // left exactly as it was found, and the audit trail does not describe a
    // transition that did not happen.
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("names every blocking step in the refusal, so the operator can act on it", async () => {
    derivation([], ["club-config", "lodges", "seasons-rates"]);

    const response = await PATCH(patch({ action: "finish" }));
    const body = (await response.json()) as { error: string };

    // Operator-readable and complete: a refusal naming only the first, or naming
    // none at all, sends somebody back to a sixteen-step checklist to guess.
    expect(body.error).toContain('"club-config"');
    expect(body.error).toContain('"lodges"');
    expect(body.error).toContain('"seasons-rates"');
    expect(body.error).toContain("Nothing was changed");
  });

  it("leaks no Prisma or snapshot detail into the refusal", async () => {
    derivation([], ["club-config"]);

    const response = await PATCH(patch({ action: "finish" }));
    const body = (await response.json()) as Record<string, unknown>;

    // The body is the message and nothing else — no stack, no `code`, no
    // snapshot, no stored row echoed back.
    expect(Object.keys(body)).toEqual(["error"]);
    expect(JSON.stringify(body)).not.toMatch(/prisma|P20\d\d|SELECT |setupProgress/i);
  });

  it("stamps the record when nothing blocks", async () => {
    derivation([], []);

    const response = await PATCH(patch({ action: "finish" }));

    expect(response.status).toBe(200);
    expect(persisted().completedAt).toBeInstanceOf(Date);
    expect(persisted().completedByMemberId).toBe("admin1");
  });

  it("counts a deliberately deferred step as no obstacle", async () => {
    // Not a separate branch in the route — `blockingStepIds` already excludes a
    // deferred step (#219 F9). Pinned from out here because it is the club's
    // whole escape route: a club that means to open with work outstanding skips
    // those steps, and the gate must not have quietly turned "outstanding" into
    // "unfinishable".
    mockFindUnique.mockResolvedValue(
      storedRow({ skippedStepIds: ["stripe", "sentry"] }),
    );
    derivation([], []);

    const response = await PATCH(patch({ action: "finish" }));

    expect(response.status).toBe(200);
    expect(persisted().completedAt).toBeInstanceOf(Date);
  });

  it.each(["complete", "skip", "reopen"] as const)(
    "does not gate %s — the other transitions stay the operator's own bookkeeping",
    async (action) => {
      derivation([], ["club-config", "lodges"]);

      const response = await PATCH(patch({ action, stepId: "stripe" }));

      // Only `finish` makes a claim the server can check. Refusing a `skip`
      // because something is outstanding would make the checklist unusable —
      // outstanding work is the reason somebody is clicking at all.
      expect(response.status).toBe(200);
      expect(mockUpsert).toHaveBeenCalledTimes(1);
    },
  );

  it("does not gate reset, which is how a club gets out of a wrong finish", async () => {
    mockFindUnique.mockResolvedValue(
      storedRow({ completedAt: new Date("2026-06-01T00:00:00.000Z") }),
    );

    const response = await PATCH(patch({ action: "reset" }));

    expect(response.status).toBe(200);
    expect(persisted().completedAt).toBeNull();
    // `reset` settles its own stale set without a recompute, so the gate has
    // nothing to consult and must not invent one.
    expect(mockRecomputeSetupProgressDerivation).not.toHaveBeenCalled();
  });

  it("lets the un-computable snapshot answer first, with its own status", async () => {
    mockRecomputeSetupProgressDerivation.mockResolvedValue(null);

    const response = await PATCH(patch({ action: "finish" }));

    // Ordering matters: "the snapshot could not be read" is retryable and is a
    // 503; "these steps are outstanding" is a 409 the operator must act on. A
    // gate that ran first would report a definite blocking list it did not
    // actually compute.
    expect(response.status).toBe(503);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("still withholds the completion stamp if a stale step ever escapes the blocking set", async () => {
    // THE COMBINATION THE REAL DERIVATION CANNOT PRODUCE, which is exactly why
    // it is stated here. Staleness clears `complete` and the blocking predicate
    // is `!complete && (stale || !deferred)`, so `stale ⊆ blocking` holds today
    // and the finish gate reaches every stale step first. The route's older
    // half-gate is therefore unreachable — and kept, because the gate above is
    // the half that can narrow (C15 narrows it; a later child could narrow it
    // further), and this is what still stops a stale record being stamped
    // complete if it ever narrows too far.
    derivation(["stripe"], []);

    const response = await PATCH(patch({ action: "finish" }));

    expect(response.status).toBe(200);
    expect(persisted().staleStepIds).toEqual(["stripe"]);
    expect(persisted().completedAt).toBeNull();
    expect(persisted().completedByMemberId).toBeNull();
  });

  it("refuses before the guard has even been passed, for a caller who is not an administrator", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    derivation([], []);

    const response = await PATCH(patch({ action: "finish" }));

    expect(response.status).toBe(403);
    expect(mockRecomputeSetupProgressDerivation).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
