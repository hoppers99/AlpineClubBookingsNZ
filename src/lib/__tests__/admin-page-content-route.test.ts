import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  pageContentFindUnique: vi.fn(),
  pageContentFindFirst: vi.fn(),
  pageContentFindMany: vi.fn(),
  pageContentCreate: vi.fn(),
  pageContentUpdate: vi.fn(),
  pageContentDelete: vi.fn(),
  publicContentSettingsFindFirst: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event, options) => ({
    data: event,
    options,
  })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
  revalidatePublicPageContent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

// The route's own permission requirement is forwarded to the mock (#2352
// MC-03D) so a content view-only officer's refusal is exercised for real,
// rather than only the no-session case.
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async (options?: unknown) =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(
      options as never,
    ),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidatePublicPageContent,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    pageContent: {
      findUnique: mocks.pageContentFindUnique,
      findFirst: mocks.pageContentFindFirst,
      findMany: mocks.pageContentFindMany,
      create: mocks.pageContentCreate,
      update: mocks.pageContentUpdate,
      delete: mocks.pageContentDelete,
    },
    publicContentSettings: {
      findFirst: mocks.publicContentSettingsFindFirst,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    $transaction: mocks.transaction,
  },
}));

import { DELETE, PATCH, POST, PUT } from "@/app/api/admin/page-content/route";
import { PAGE_CONTENT_LIMITS } from "@/lib/page-content";

function jsonRequest(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body: unknown,
) {
  return new NextRequest("http://localhost/api/admin/page-content", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };
// Content is view-only for this role (`ADMIN_READONLY` in admin-permissions.ts),
// so it reaches the panel and is refused by every mutating method.
const viewOnlyAdminSession = {
  user: {
    id: "readonly-1",
    role: "ADMIN",
    accessRoles: [{ role: "ADMIN_READONLY" }],
  },
};

const baseCreateBody = {
  caption: "Trips",
  menuTitle: "Trips",
  title: "Trip Reports",
  headerText: "<p>Latest trips</p>",
  slug: "trip-reports",
  sortOrder: 40,
};

describe("POST /api/admin/page-content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.pageContentFindFirst.mockResolvedValue(null);
    mocks.pageContentCreate.mockImplementation(async ({ data }) => ({
      id: "page-1",
      ...data,
      updatedAt: new Date("2026-06-11T00:00:00Z"),
    }));
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("requires an admin session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await POST(jsonRequest("POST", baseCreateBody));
    expect(response.status).toBe(401);
    expect(mocks.pageContentCreate).not.toHaveBeenCalled();
  });

  it("sanitises headerText before storing it", async () => {
    const response = await POST(
      jsonRequest("POST", {
        ...baseCreateBody,
        headerText: '<p>ok</p><script>alert("x")</script>',
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.pageContentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ headerText: "<p>ok</p>" }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });

  it("rejects slugs containing reserved segments", async () => {
    const response = await POST(
      jsonRequest("POST", { ...baseCreateBody, slug: "admin/settings" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.pageContentCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("rejects duplicate slugs", async () => {
    mocks.pageContentFindFirst.mockResolvedValue({ id: "existing" });
    const response = await POST(jsonRequest("POST", baseCreateBody));
    expect(response.status).toBe(409);
  });
});

describe("PUT /api/admin/page-content", () => {
  const baseUpdateBody = {
    id: "page-1",
    ...baseCreateBody,
    contentHtml: "<p>Body</p>",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "page-1",
      contentHtml: "<p>Old</p>",
    });
    mocks.pageContentFindFirst.mockResolvedValue(null);
    mocks.pageContentUpdate.mockImplementation(async ({ data }) => ({
      id: "page-1",
      ...data,
      updatedAt: new Date("2026-06-11T00:00:00Z"),
    }));
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("sanitises contentHtml and headerText before storing them", async () => {
    const response = await PUT(
      jsonRequest("PUT", {
        ...baseUpdateBody,
        headerText: '<p onclick="x()">intro</p>',
        contentHtml: '<p>ok</p><style>body{display:none}</style>',
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.pageContentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headerText: "<p>intro</p>",
          contentHtml: "<p>ok</p>",
        }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });

  it("rejects slugs containing reserved segments", async () => {
    const response = await PUT(
      jsonRequest("PUT", { ...baseUpdateBody, slug: "api/pages" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/page-content (publish toggle)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.pageContentUpdate.mockImplementation(async ({ data }) => ({
      id: "page-1",
      slug: "trip-reports",
      path: "/trip-reports",
      ...data,
      updatedAt: new Date("2026-06-28T00:00:00Z"),
    }));
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("requires an admin session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { id: "page-1", published: false }),
    );
    expect(response.status).toBe(401);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the page does not exist", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { id: "missing", published: false }),
    );
    expect(response.status).toBe(404);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
  });

  it("hides an admin-created page and audits the change", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "page-1",
      slug: "trip-reports",
      path: "/trip-reports",
      published: true,
    });

    const response = await PATCH(
      jsonRequest("PATCH", { id: "page-1", published: false }),
    );

    expect(response.status).toBe(200);
    expect(mocks.pageContentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ published: false }),
      }),
    );
    expect(mocks.buildStructuredAuditLogCreateArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAGE_CONTENT_VISIBILITY_CHANGED",
        metadata: expect.objectContaining({
          slug: "trip-reports",
          published: false,
        }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });

  it("blocks hiding a system page", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "home-id",
      slug: "home",
      path: "/home",
      published: true,
    });

    const response = await PATCH(
      jsonRequest("PATCH", { id: "home-id", published: false }),
    );

    expect(response.status).toBe(422);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("blocks hiding a built-in design page", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "about-id",
      slug: "about",
      path: "/about",
      published: true,
    });

    const response = await PATCH(
      jsonRequest("PATCH", { id: "about-id", published: false }),
    );

    expect(response.status).toBe(422);
    expect(mocks.pageContentUpdate).not.toHaveBeenCalled();
  });

  it("re-publishes a built-in page without the guard blocking it", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "about-id",
      slug: "about",
      path: "/about",
      published: false,
    });

    const response = await PATCH(
      jsonRequest("PATCH", { id: "about-id", published: true }),
    );

    expect(response.status).toBe(200);
    expect(mocks.pageContentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ published: true }),
      }),
    );
  });
});

/*
  #2352 MC-03D. The supported hard delete for CMS page content.

  What these cases are FOR, stated once so a later reader does not loosen them:
  the measurement gate needs a supported writer whose invalidation can be proved,
  and the writer is only safe because of four properties — it refuses anyone
  without content edit, it refuses a page the product itself links, the row and
  its audit snapshot move together, and nothing is written on any refused path.
  So every case below asserts what the database and the response DID, not that a
  helper was merely reached.
*/
describe("DELETE /api/admin/page-content", () => {
  const probeRow = {
    id: "page-1",
    slug: "trip-reports",
    path: "/trip-reports",
    caption: "Trips",
    menuTitle: "Trips",
    title: "Trip Reports",
    headerText: "<p>Latest trips</p>",
    sortOrder: 40,
    contentHtml: "<p>Body</p>",
    published: true,
    updatedByMemberId: "admin-1",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-11T00:00:00Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.pageContentFindUnique.mockResolvedValue(probeRow);
    mocks.pageContentFindMany.mockResolvedValue([]);
    mocks.publicContentSettingsFindFirst.mockResolvedValue(null);
    mocks.pageContentDelete.mockResolvedValue(probeRow);
    mocks.auditLogCreate.mockResolvedValue({});
    // Interactive transaction: run the callback against the mocked models, so
    // the ordering inside it is exercised rather than stubbed away.
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        pageContent: { delete: mocks.pageContentDelete },
        auditLog: { create: mocks.auditLogCreate },
      }),
    );
  });

  it("requires a session", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await DELETE(jsonRequest("DELETE", { id: "page-1" }));

    expect(response.status).toBe(401);
    expect(mocks.pageContentDelete).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("refuses a content view-only officer, and writes nothing", async () => {
    mocks.auth.mockResolvedValue(viewOnlyAdminSession);

    const response = await DELETE(jsonRequest("DELETE", { id: "page-1" }));

    // 403 from the shared guard mock; production answers 401 through this
    // route's deliberate `forbiddenResponse`, which the admin panel treats as
    // forbidden too. Either way it is a refusal, and nothing is written.
    expect(response.status).toBe(403);
    expect(mocks.pageContentDelete).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("returns 404 when the page does not exist", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(null);

    const response = await DELETE(jsonRequest("DELETE", { id: "missing" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Page not found" });
    expect(mocks.pageContentDelete).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("rejects a malformed body without reading the page", async () => {
    const response = await DELETE(
      jsonRequest("DELETE", { id: "page-1", published: false }),
    );

    expect(response.status).toBe(400);
    expect(mocks.pageContentFindUnique).not.toHaveBeenCalled();
    expect(mocks.pageContentDelete).not.toHaveBeenCalled();
  });

  it("deletes the row and records the complete before snapshot in one transaction", async () => {
    const response = await DELETE(jsonRequest("DELETE", { id: "page-1" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      page: {
        id: "page-1",
        slug: "trip-reports",
        path: "/trip-reports",
        title: "Trip Reports",
        published: true,
      },
      referencedBySlugs: [],
      wasBookNowTarget: false,
    });

    // The row is gone, addressed by id.
    expect(mocks.pageContentDelete).toHaveBeenCalledWith({
      where: { id: "page-1" },
    });

    // …and the audit row that is its only recovery route went with it, inside
    // the same transaction callback.
    expect(mocks.transaction).toHaveBeenCalledOnce();
    const [auditEvent, auditOptions] =
      mocks.buildStructuredAuditLogCreateArgs.mock.calls.at(-1)!;
    expect(auditEvent).toMatchObject({
      action: "PAGE_CONTENT_DELETED",
      actor: { memberId: "admin-1" },
      entity: { type: "PageContent", id: "page-1" },
      category: "admin",
      severity: "important",
      outcome: "success",
    });
    // The whole row, not a summary of it: this snapshot IS the recovery route
    // that makes a final delete acceptable.
    expect(auditEvent.metadata.before).toEqual({
      id: "page-1",
      slug: "trip-reports",
      path: "/trip-reports",
      caption: "Trips",
      menuTitle: "Trips",
      title: "Trip Reports",
      headerText: "<p>Latest trips</p>",
      sortOrder: 40,
      contentHtml: "<p>Body</p>",
      published: true,
      updatedByMemberId: "admin-1",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
    });
    // Archive mode at this route's own caps. Without it the audit log clips
    // every string at 1,000 characters and the "complete" snapshot above would
    // be the first paragraph of a real page; sized on the body cap ALONE, a page
    // at both caps at once overflows the whole-metadata budget and the snapshot
    // is replaced by a preview stub.
    expect(auditOptions).toEqual({
      archiveText: {
        maxStringLength:
          PAGE_CONTENT_LIMITS.contentHtmlMax +
          PAGE_CONTENT_LIMITS.headerTextMax,
      },
    });
    // The retention class is NOT hand-set: the classifier derives seven-year
    // `critical` from admin + important + a non-access action name. Asserted
    // against the REAL classifier (this file mocks `@/lib/audit`), because a
    // hand-set value is exactly the drift it exists to prevent.
    expect(auditEvent).not.toHaveProperty("retentionClass");
    const { classifyAuditRetention } =
      await vi.importActual<typeof import("@/lib/audit")>("@/lib/audit");
    expect(
      classifyAuditRetention({
        action: auditEvent.action,
        category: auditEvent.category,
        severity: auditEvent.severity,
      }),
    ).toBe("critical");
  });

  it("clears the stored public site after the transaction commits", async () => {
    const order: string[] = [];
    mocks.transaction.mockImplementation(async (callback) => {
      const result = await callback({
        pageContent: { delete: mocks.pageContentDelete },
        auditLog: { create: mocks.auditLogCreate },
      });
      order.push("transaction");
      return result;
    });
    mocks.revalidatePublicPageContent.mockImplementation(() => {
      order.push("invalidate");
    });

    const response = await DELETE(jsonRequest("DELETE", { id: "page-1" }));

    expect(response.status).toBe(200);
    // Order is the property, not the count: invalidating before a transaction
    // that rolls back costs a cold render, but deleting and then failing before
    // the call leaves the deleted page answering 200 from the store, and
    // `revalidate = 300` is no bound on that.
    expect(order).toEqual(["transaction", "invalidate"]);
  });

  it("does not clear the stored public site when the write fails", async () => {
    mocks.transaction.mockRejectedValue(new Error("deadlock detected"));

    await expect(
      DELETE(jsonRequest("DELETE", { id: "page-1" })),
    ).rejects.toThrow("deadlock detected");

    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("refuses to delete a system page", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      ...probeRow,
      id: "home-id",
      slug: "home",
      path: "/home",
    });

    const response = await DELETE(jsonRequest("DELETE", { id: "home-id" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "This page cannot be deleted from the public site",
    });
    expect(mocks.pageContentDelete).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("refuses to delete a built-in design page", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      ...probeRow,
      id: "about-id",
      slug: "about",
      path: "/about",
    });

    const response = await DELETE(jsonRequest("DELETE", { id: "about-id" }));

    expect(response.status).toBe(422);
    expect(mocks.pageContentDelete).not.toHaveBeenCalled();
  });

  it("reports the pages that still link to the deleted address, and deletes anyway", async () => {
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "2026-agm" },
      { slug: "news" },
    ]);

    const response = await DELETE(jsonRequest("DELETE", { id: "page-1" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.referencedBySlugs).toEqual(["2026-agm", "news"]);
    // Permitted, not blocked (D-B4(a)): a substring check that REFUSED would be
    // bypassable by spelling the link differently, so it warns instead.
    expect(mocks.pageContentDelete).toHaveBeenCalledOnce();
    // The report is searched on the page's own path, excluding itself.
    expect(mocks.pageContentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { not: "page-1" },
          OR: [
            { contentHtml: { contains: "/trip-reports" } },
            { headerText: { contains: "/trip-reports" } },
          ],
        },
      }),
    );
    // …and it is preserved in the audit row, not only in the response.
    const [auditEvent] =
      mocks.buildStructuredAuditLogCreateArgs.mock.calls.at(-1)!;
    expect(auditEvent.metadata.referencedBySlugs).toEqual([
      "2026-agm",
      "news",
    ]);
  });

  it("reports that the Book Now button was pointing at the deleted page", async () => {
    mocks.publicContentSettingsFindFirst.mockResolvedValue({ id: "default" });

    const response = await DELETE(jsonRequest("DELETE", { id: "page-1" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.wasBookNowTarget).toBe(true);
    // Gated on the live target, not merely the stored id: the settings PUT never
    // keeps a page id while the target is the booking flow, and a legacy row
    // that did is already sending visitors to the booking flow.
    expect(mocks.publicContentSettingsFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookNowPageId: "page-1", bookNowTarget: "PAGE" },
      }),
    );
    // The FK is `onDelete: SetNull` and `getBookNowConfig()` fails open, so the
    // button reverts to the booking flow rather than dangling — the delete does
    // not have to null anything itself, and must not refuse.
    expect(mocks.pageContentDelete).toHaveBeenCalledOnce();
    const [auditEvent] =
      mocks.buildStructuredAuditLogCreateArgs.mock.calls.at(-1)!;
    expect(auditEvent.metadata.wasBookNowTarget).toBe(true);
  });
});
