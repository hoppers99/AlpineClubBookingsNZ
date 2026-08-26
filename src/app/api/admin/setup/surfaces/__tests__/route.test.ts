import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The legacy-surfaces switch's own API (epic #213, C8, #223).
 *
 * FIVE THINGS THIS ROUTE HAS TO GET RIGHT, each of which is silent when wrong:
 * it must refuse before it reads or writes anything, at two different levels
 * for the two verbs; it must refuse a body that is not exactly one boolean; it
 * must record a `from`/`to` pair whose `from` is the value read INSIDE the
 * transaction rather than whatever a render path happened to cache; it must
 * answer a lost race as a retryable 503 rather than a 500; and it must never
 * put a Prisma error in a response body.
 *
 * MOCKED AT THE SEAMS, not at a database: the guard, the Prisma client and the
 * audit writer. `$transaction` is stubbed to invoke its callback with the same
 * delegate object, which is what lets the read-inside-the-transaction assertion
 * be made at all — a `before` read from outside would not appear on `tx`.
 */

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
/**
 * Calls recorded in order AND by which client made them. The two delegates are
 * deliberately distinct objects: a `before` read taken outside the transaction
 * would be recorded as `prisma.findUnique` and the ordering assertion below
 * would fail, which is the only way that regression is visible from a mock.
 */
const calls: string[] = [];
const mockTransaction = vi.fn();

function delegateFor(client: "prisma" | "tx") {
  return {
    findUnique: (...args: unknown[]) => {
      calls.push(`${client}.findUnique`);
      return mockFindUnique(...args);
    },
    upsert: (...args: unknown[]) => {
      calls.push(`${client}.upsert`);
      return mockUpsert(...args);
    },
  };
}

const prismaDelegate = delegateFor("prisma");
const txDelegate = delegateFor("tx");

vi.mock("@/lib/prisma", () => ({
  prisma: {
    get setupSurfaceSettings() {
      return prismaDelegate;
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

const mockLogAudit = vi.fn();
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock("@/lib/logger", () => ({
  default: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

import { GET, PUT } from "@/app/api/admin/setup/surfaces/route";

function putRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://example.org/api/admin/setup/surfaces", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** A body that is not JSON at all, which the route answers 400 before parsing. */
function malformedRequest() {
  return new NextRequest("https://example.org/api/admin/setup/surfaces", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{ not json",
  });
}

function prismaError(code: string) {
  return Object.assign(new Error(`Prisma error ${code}`), { code });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mockRequireAdmin.mockResolvedValue({
    ok: true as const,
    session: { user: { id: "admin1" } },
  });
  mockFindUnique.mockResolvedValue(null);
  mockUpsert.mockImplementation(async (args: { create?: unknown; update?: unknown }) => ({
    id: "default",
    legacySurfacesHidden: Boolean(
      (args.update as { legacySurfacesHidden?: boolean } | undefined)
        ?.legacySurfacesHidden,
    ),
  }));
  mockTransaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ setupSurfaceSettings: txDelegate }),
  );
});

describe("GET /api/admin/setup/surfaces", () => {
  it("asks for support VIEW, and refuses before reading anything", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockRequireAdmin).toHaveBeenCalledWith({
      permission: { area: "support", level: "view" },
    });
  });

  it("answers the stored value, normalised", async () => {
    mockFindUnique.mockResolvedValue({ legacySurfacesHidden: true });

    const body = (await (await GET()).json()) as {
      settings: { legacySurfacesHidden: boolean };
    };

    expect(body).toEqual({ settings: { legacySurfacesHidden: true } });
  });

  it("answers the DEFAULT — shown — when the club has no row", async () => {
    // The fail-open direction the whole flag rests on (#223 AC4).
    const body = (await (await GET()).json()) as {
      settings: { legacySurfacesHidden: boolean };
    };

    expect(body.settings.legacySurfacesHidden).toBe(false);
  });
});

describe("PUT /api/admin/setup/surfaces — the guard", () => {
  it("asks for support EDIT, and refuses before writing anything", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await PUT(putRequest({ legacySurfacesHidden: true }));

    expect(response.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockRequireAdmin).toHaveBeenCalledWith({
      permission: { area: "support", level: "edit" },
    });
  });
});

describe("PUT /api/admin/setup/surfaces — the body", () => {
  it("refuses a body that is not JSON", async () => {
    const response = await PUT(malformedRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  const REFUSED: readonly { name: string; body: unknown }[] = [
    { name: "an extra key (.strict())", body: { legacySurfacesHidden: true, sneak: 1 } },
    { name: "a non-boolean value", body: { legacySurfacesHidden: "true" } },
    { name: "the field missing", body: {} },
    { name: "null", body: null },
  ];

  for (const { name, body } of REFUSED) {
    it(`refuses ${name}, and writes nothing`, async () => {
      const response = await PUT(putRequest(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          "Choose whether the legacy setup surfaces are shown or hidden.",
      });
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  }
});

describe("PUT /api/admin/setup/surfaces — the write and its trail", () => {
  it("reads the previous value INSIDE the Serializable transaction, before the write", async () => {
    await PUT(putRequest({ legacySurfacesHidden: true }));

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransaction.mock.calls[0][1]).toEqual({
      isolationLevel: "Serializable",
    });
    // Both calls came from the `tx` handed to the callback, in order — and
    // nothing was read off the ambient client on the way in.
    expect(calls).toEqual(["tx.findUnique", "tx.upsert"]);
  });

  it("creates the row lazily on a club that has never saved", async () => {
    await PUT(putRequest({ legacySurfacesHidden: true }));

    const args = mockUpsert.mock.calls[0][0];
    expect(args.where).toEqual({ id: "default" });
    expect(args.create).toEqual({
      id: "default",
      legacySurfacesHidden: true,
      updatedByMemberId: "admin1",
    });
    expect(args.update).toEqual({
      legacySurfacesHidden: true,
      updatedByMemberId: "admin1",
    });
  });

  it("updates an existing row, and audits from the value it actually held", async () => {
    mockFindUnique.mockResolvedValue({ legacySurfacesHidden: true });
    mockUpsert.mockResolvedValue({ id: "default", legacySurfacesHidden: false });

    const response = await PUT(
      putRequest({ legacySurfacesHidden: false }, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }),
    );

    expect(await response.json()).toEqual({
      settings: { legacySurfacesHidden: false },
    });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const audit = mockLogAudit.mock.calls[0][0];
    expect(audit).toMatchObject({
      action: "setup_surfaces.legacy_visibility_changed",
      category: "system",
      memberId: "admin1",
      entityType: "SetupSurfaceSettings",
      entityId: "default",
      outcome: "success",
      // First hop only, trimmed — not the whole forwarding chain.
      ipAddress: "203.0.113.7",
    });
    expect(JSON.parse(audit.details)).toEqual({ from: true, to: false });
  });

  it("audits `from: false` when there was no row — absent is SHOWN, not unknown", async () => {
    await PUT(putRequest({ legacySurfacesHidden: true }));

    expect(JSON.parse(mockLogAudit.mock.calls[0][0].details)).toEqual({
      from: false,
      to: true,
    });
  });

  it("records `unknown` rather than inventing an address when none was forwarded", async () => {
    await PUT(putRequest({ legacySurfacesHidden: true }));

    expect(mockLogAudit.mock.calls[0][0].ipAddress).toBe("unknown");
  });
});

describe("PUT /api/admin/setup/surfaces — failure", () => {
  const RETRYABLE = ["P2002", "P2028", "P2034"];

  for (const code of RETRYABLE) {
    it(`answers ${code} as a retryable 503, leaking nothing`, async () => {
      mockTransaction.mockRejectedValue(prismaError(code));

      const response = await PUT(putRequest({ legacySurfacesHidden: true }));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Another update is in progress — try again shortly.",
      });
      expect(mockLoggerWarn).toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  }

  it("answers any other database fault as a 500 whose body names nothing", async () => {
    mockTransaction.mockRejectedValue(
      Object.assign(new Error('column "SetupSurfaceSettings.legacySurfacesHidden" does not exist'), {
        code: "P2022",
      }),
    );

    const response = await PUT(putRequest({ legacySurfacesHidden: true }));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to save these settings" });
    expect(body.error).not.toMatch(/column|Prisma|P2022|SetupSurfaceSettings/);
    // The detail goes to the log, where an operator can find it.
    expect(mockLoggerError).toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("answers a plain thrown error as a 500 too — a code-less fault is not retryable", async () => {
    mockTransaction.mockRejectedValue(new Error("connection reset"));

    const response = await PUT(putRequest({ legacySurfacesHidden: true }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to save these settings",
    });
  });
});
