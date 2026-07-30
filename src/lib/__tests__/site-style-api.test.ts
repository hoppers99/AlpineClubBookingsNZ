import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLUB_THEME_VALUES } from "@/lib/club-theme-schema";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  clubThemeFindUnique: vi.fn(),
  clubThemeUpsert: vi.fn(),
  queryRaw: vi.fn(),
  mediaImageDeleteMany: vi.fn(),
  mediaImageFindFirst: vi.fn(),
  clubThemeCreateMany: vi.fn(),
  transaction: vi.fn(),
  auditLogCreate: vi.fn(),
  revalidatePath: vi.fn(),
  primeEmailPalette: vi.fn(),
  invalidatePublicLayoutConfig: vi.fn(),
}));

vi.mock("@/lib/public-layout-cache", () => ({
  PUBLIC_LAYOUT_CACHE_TAGS: { theme: "public-layout:theme" },
  invalidatePublicLayoutConfig: mocks.invalidatePublicLayoutConfig,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

// #1912: the route re-primes the cached email brand palette after a save so
// emails pick up the new scheme immediately. Mock it to assert the wiring.
vi.mock("@/lib/email-theme", () => ({
  primeEmailPalette: mocks.primeEmailPalette,
}));

// saveClubTheme runs its write plus the previous logo blob's cleanup in one
// transaction (#2322), so the mock hands the callback a tx with the same shape.
const txClient = {
  clubTheme: {
    findUnique: mocks.clubThemeFindUnique,
    upsert: mocks.clubThemeUpsert,
    update: mocks.clubThemeUpsert,
    createMany: mocks.clubThemeCreateMany,
  },
  mediaImage: {
    deleteMany: mocks.mediaImageDeleteMany,
    findFirst: mocks.mediaImageFindFirst,
  },
  $queryRaw: mocks.queryRaw,
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTheme: {
      findUnique: mocks.clubThemeFindUnique,
      upsert: mocks.clubThemeUpsert,
    },
    mediaImage: { deleteMany: mocks.mediaImageDeleteMany },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    $queryRaw: mocks.queryRaw,
    $transaction: (
      fn: (tx: typeof txClient) => unknown,
      options?: unknown,
    ) => mocks.transaction(fn, options),
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { PUT } from "@/app/api/admin/site-style/route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/site-style", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("site style admin API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
    });
    mocks.clubThemeFindUnique.mockResolvedValue(null);
    // saveClubTheme now materialises the singleton then `update({where,data})`
    // inside its transaction (#2322), so `data` is the write shape; `create`/
    // `update` stay handled for any caller still using upsert.
    mocks.clubThemeUpsert.mockImplementation(({ create, update, data }) => {
      const written = data ?? create ?? update;
      return Promise.resolve({
        ...written,
        completedAt: written?.completedAt ?? null,
      });
    });
    mocks.auditLogCreate.mockResolvedValue({});
    // No previously-stored logo unless a test says otherwise.
    mocks.queryRaw.mockResolvedValue([{ logoUrl: null }]);
    mocks.mediaImageDeleteMany.mockResolvedValue({ count: 0 });
    mocks.clubThemeCreateMany.mockResolvedValue({ count: 0 });
    // The referenced logo blob exists unless a test says otherwise.
    mocks.mediaImageFindFirst.mockResolvedValue({ id: "img-1" });
    mocks.transaction.mockImplementation((fn: (tx: typeof txClient) => unknown) =>
      fn(txClient),
    );
    mocks.primeEmailPalette.mockResolvedValue(undefined);
  });

  it("lets a club with an 860KB stored logo save an unrelated change (#2322)", async () => {
    // The regression this guards: the wizard round-trips the WHOLE theme, so a
    // stateless 64KB rule would reject the club's own existing logo on every
    // save and block it from editing its colours at all.
    const legacyLogo = `data:image/png;base64,${Buffer.alloc(860_000, 0x61).toString("base64")}`;
    mocks.clubThemeFindUnique.mockResolvedValue({
      completedAt: null,
      logoDataUrl: legacyLogo,
    });

    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        brandGold: "#123456",
        logoDataUrl: legacyLogo,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.clubThemeUpsert).toHaveBeenCalled();
  });

  it("rejects a CHANGED inlined logo above the 64KB budget (#2322)", async () => {
    mocks.clubThemeFindUnique.mockResolvedValue({
      completedAt: null,
      logoDataUrl: null,
    });

    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        logoDataUrl: `data:image/png;base64,${Buffer.alloc(300_000, 0x61).toString("base64")}`,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.details.fieldErrors.logoDataUrl[0]).toContain("64KB");
    expect(mocks.clubThemeUpsert).not.toHaveBeenCalled();
  });

  it("deletes the previous LOGO blob when the logo is replaced (#2322)", async () => {
    mocks.queryRaw.mockResolvedValue([{ logoUrl: "/api/images/old-logo" }]);

    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        logoUrl: "/api/images/new-logo",
      }),
    );

    expect(response.status).toBe(200);
    // Scoped to LOGO so a CONTENT picker image can never be collected.
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalledWith({
      where: { id: "old-logo", kind: "LOGO" },
    });
  });

  it("does not delete the logo blob when it is unchanged (#2322)", async () => {
    mocks.queryRaw.mockResolvedValue([{ logoUrl: "/api/images/same-logo" }]);

    await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        logoUrl: "/api/images/same-logo",
      }),
    );

    expect(mocks.mediaImageDeleteMany).not.toHaveBeenCalled();
  });

  it("clears the inlined logo when a served-image URL is saved (#2322)", async () => {
    // The server does the clearing, not the client: a stale wizard could
    // otherwise re-inline ~1.2MB of base64 onto a row already migrated to URL
    // form, putting the megabytes back on every public page render.
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        logoUrl: "/api/images/logo999",
        logoDataUrl: "data:image/png;base64,AAAA",
      }),
    );

    expect(response.status).toBe(200);
    const written = mocks.clubThemeUpsert.mock.calls[0][0].data;
    expect(written.logoUrl).toBe("/api/images/logo999");
    expect(written.logoDataUrl).toBeNull();
  });

  it("keeps an inlined logo when no served-image URL is set (#2322)", async () => {
    // The back-compat path: deployments that have not re-uploaded must keep
    // their stored data URI.
    const dataUrl = "data:image/png;base64,AAAA";
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        logoUrl: null,
        logoDataUrl: dataUrl,
      }),
    );

    expect(response.status).toBe(200);
    const written = mocks.clubThemeUpsert.mock.calls[0][0].data;
    expect(written.logoUrl).toBeNull();
    expect(written.logoDataUrl).toBe(dataUrl);
  });

  it("409s a stale tab whose logo blob is gone, deleting nothing (#2322)", async () => {
    // Two-tab sequence: tab B saved logo B (deleting A). Tab A, still open, now
    // saves referencing A. Writing it would dangle the theme, and on the next
    // save would delete B — a blob that IS still referenced.
    mocks.queryRaw.mockResolvedValue([{ logoUrl: "/api/images/logo-b" }]);
    mocks.mediaImageFindFirst.mockResolvedValue(null); // logo A no longer exists

    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        logoUrl: "/api/images/logo-a",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("no longer available");
    // Nothing written, nothing deleted — the row keeps pointing at B.
    expect(mocks.clubThemeUpsert).not.toHaveBeenCalled();
    expect(mocks.mediaImageDeleteMany).not.toHaveBeenCalled();
  });

  it("accepts a save whose logo blob is still present (#2322)", async () => {
    mocks.queryRaw.mockResolvedValue([{ logoUrl: "/api/images/logo-a" }]);
    mocks.mediaImageFindFirst.mockResolvedValue({ id: "logo-b" });

    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        logoUrl: "/api/images/logo-b",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalledWith({
      where: { id: "logo-a", kind: "LOGO" },
    });
  });

  it("503s rather than 500s when another transaction holds the theme row (#2322)", async () => {
    // Config-transfer apply holds the ClubTheme row for its whole bundle
    // transaction, so a save landing mid-import legitimately times out waiting.
    const timeout = Object.assign(new Error("Transaction API error"), {
      code: "P2028",
    });
    mocks.transaction.mockRejectedValue(timeout);

    const response = await PUT(request({ ...DEFAULT_CLUB_THEME_VALUES }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toContain("try again shortly");
  });

  it("still 500s on an unexpected failure", async () => {
    mocks.transaction.mockRejectedValue(new Error("boom"));

    const response = await PUT(request({ ...DEFAULT_CLUB_THEME_VALUES }));

    expect(response.status).toBe(500);
  });

  it("serialises a first-ever save by materialising the singleton first (#2322)", async () => {
    // FOR UPDATE locks nothing when the row is absent, so the transaction
    // creates the row before locking it.
    mocks.queryRaw.mockResolvedValue([]);

    const response = await PUT(request({ ...DEFAULT_CLUB_THEME_VALUES }));

    expect(response.status).toBe(200);
    expect(mocks.clubThemeCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it("rejects unsafe colour values before storage", async () => {
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        brandGold: "#ffcb05; color:red",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid input");
    expect(mocks.clubThemeUpsert).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("saves a low-contrast seed palette now that contrast is guaranteed by construction (#2187)", async () => {
    // The three seeds feed the vendored Radix generator, whose banded 12-step
    // substrate clears the guarantee sweep for every seed — a pathological pick
    // is adjusted, not rejected. The old blocking contrast gate (which returned
    // 400 for a near-identical accent/neutral pair) is gone, so this now SAVES.
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        brandGold: "#33373e",
        brandDeep: "#30343b",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.theme).toBeTruthy();
    expect(body.error).toBeUndefined();
    expect(mocks.clubThemeUpsert).toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });

  it("saves completion and revalidates every themed layout", async () => {
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        completeSetup: true,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.invalidatePublicLayoutConfig).toHaveBeenCalledWith(
      "public-layout:theme",
    );
    expect(body.theme.completedAt).toEqual(expect.any(String));
    expect(mocks.clubThemeUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        data: expect.objectContaining({
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(mocks.revalidatePath.mock.calls).toEqual([
      ["/(website)", "layout"],
      ["/(authenticated)", "layout"],
      ["/(admin)", "layout"],
    ]);
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("re-primes the email palette after a successful save so emails use the new scheme (#1912)", async () => {
    const response = await PUT(request({ ...DEFAULT_CLUB_THEME_VALUES }));

    expect(response.status).toBe(200);
    expect(mocks.clubThemeUpsert).toHaveBeenCalled();
    // The email brand palette is cached separately from the app-shell CSS, so
    // the save must explicitly refresh it or emails keep the old colours.
    expect(mocks.primeEmailPalette).toHaveBeenCalledTimes(1);
  });

  it("does not re-prime the email palette when the save is rejected (#1912)", async () => {
    const response = await PUT(
      request({ ...DEFAULT_CLUB_THEME_VALUES, brandGold: "not-a-colour" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.clubThemeUpsert).not.toHaveBeenCalled();
    expect(mocks.primeEmailPalette).not.toHaveBeenCalled();
  });
});
