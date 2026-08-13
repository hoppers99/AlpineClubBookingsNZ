import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * `GET /api/admin/members/[id]/dependent-email-source` (#2282 review).
 *
 * "If a dependent were recorded under this member, whose mailbox would their
 * club email actually land in?" Both link dialogs ask it, because the picker
 * they show lists PARENTS while the write stores only a parent who can actually
 * receive mail — so the option label was naming somebody the mail would never
 * reach. Since #2716 the answer is that parent or nobody, and "nobody" is the
 * answer the dialogs must be able to show, because it is now a routine outcome
 * rather than an edge case.
 *
 * What is pinned here: the admin gate, the 404 for a member who does not exist
 * (which must NOT read as "no adult in this family", a different and misleading
 * statement), the resolved answer, and the null answer that makes the dialogs
 * refuse the save.
 */
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/admin/members/[id]/dependent-email-source/route";

const mockedFindUnique = vi.mocked(prisma.member.findUnique);
const mockedFindMany = vi.mocked(prisma.member.findMany);

function request(id = "tui") {
  return new NextRequest(
    `http://localhost/api/admin/members/${id}/dependent-email-source`,
  );
}

function call(id = "tui") {
  return GET(request(id), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "a" } } });
});

describe("GET /api/admin/members/[id]/dependent-email-source", () => {
  it("is gated on membership:view and returns the guard's own response", async () => {
    const denied = new Response("no", { status: 403 });
    mockRequireAdmin.mockResolvedValue({ ok: false, response: denied });

    const res = await call();

    expect(res).toBe(denied);
    expect(mockRequireAdmin).toHaveBeenCalledWith({
      permission: { area: "membership", level: "view" },
    });
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("404s a member who does not exist rather than answering 'nobody'", async () => {
    mockedFindUnique.mockResolvedValue(null);

    const res = await call("ghost");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Member not found" });
    // The walk is never run for a member that is not there — a null resolution
    // would render in the dialog as "no adult in this family can receive club
    // email", which is a different claim entirely.
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("names the adult the write would actually store", async () => {
    // Whatever this route says is what the write will do — that is its entire
    // purpose, so the fixture is the ordinary case: an adult parent with a real
    // address, who under #2716 IS the source rather than a step on the way to
    // one.
    mockedFindUnique
      .mockResolvedValueOnce({ id: "nan" } as never)
      .mockResolvedValueOnce({
        id: "nan",
        email: "nan@example.org",
        ageTier: "ADULT",
        archivedAt: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      } as never)
      .mockResolvedValueOnce({
        id: "nan",
        firstName: "Nan",
        lastName: "Rangi",
        email: "nan@example.org",
      } as never);

    const res = await call("nan");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      source: {
        id: "nan",
        firstName: "Nan",
        lastName: "Rangi",
        email: "nan@example.org",
      },
    });
  });

  it("answers null for a young parent instead of naming somebody above them (#2716)", async () => {
    // Tui is a 16-year-old parent with a real address of their own. Being the
    // club's contact of record is a responsibility function and stays
    // adult-only, so Tui is refused — and since #2716 the answer stops there
    // rather than continuing to Tui's own parent. The dialog therefore shows the
    // admin the same "nobody" the write route will enforce, instead of naming a
    // grandparent the write would no longer accept.
    mockedFindUnique
      .mockResolvedValueOnce({ id: "tui" } as never)
      .mockResolvedValueOnce({
        id: "tui",
        email: "tui@example.org",
        ageTier: "YOUTH",
        archivedAt: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      } as never);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: null });
    // No second lookup: there is nowhere further to look.
    expect(mockedFindMany).not.toHaveBeenCalled();
  });
});
