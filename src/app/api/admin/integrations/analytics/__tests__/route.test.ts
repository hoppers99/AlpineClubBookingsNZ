import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  settingsFindUnique: vi.fn(),
  settingsUpsert: vi.fn(),
  pageContentFindUnique: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  buildAudit: vi.fn((event) => ({ data: event })),
  revalidatePublicSite: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildAudit,
  getAuditRequestContext: () => ({
    id: "req-1",
    ipAddress: "1.2.3.4",
    userAgent: "vitest",
  }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    analyticsSettings: {
      findUnique: mocks.settingsFindUnique,
      upsert: mocks.settingsUpsert,
    },
    pageContent: { findUnique: mocks.pageContentFindUnique },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));
// `revalidatePath` needs a static-generation store no unit test has; the shared
// helper's own behaviour is pinned by public-content-invalidation-contract.
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: mocks.revalidatePublicSite,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET, PUT } from "../route";
import { POST as RECONSENT } from "../reconsent/route";
import { DEFAULT_ANALYTICS_BANNER_MESSAGE } from "@/lib/analytics-settings";
import { PUBLIC_LAYOUT_CACHE_TAGS } from "@/lib/public-layout-cache";

/**
 * The Google Analytics integration write surface (#2573, owner decision section 12):
 * server-side permission checks on every read and write, an audit entry for every
 * change, public-cache invalidation on every save, and the strict separation between
 * an ordinary Save and the explicit "Ask visitors to choose again" action.
 */

const STORED = {
  measurementId: "G-OLD1234567",
  consentBannerEnabled: true,
  bannerMessage: "Old wording.",
  consentRevision: 3,
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedByMemberId: "admin-0",
};

function putRequest(body: unknown, raw?: string) {
  return new Request(
    "https://club.example.com/api/admin/integrations/analytics",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    },
  );
}

function reconsentRequest() {
  return new Request(
    "https://club.example.com/api/admin/integrations/analytics/reconsent",
    { method: "POST" },
  );
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    measurementId: "G-NEW1234567",
    consentBannerEnabled: true,
    bannerMessage: "We use optional Google Analytics.",
    ...overrides,
  };
}

/** The row the upsert would have produced, so the response echoes storage. */
function upsertEcho(args: {
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
}) {
  return {
    ...STORED,
    ...(args.update ?? {}),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.buildAudit.mockImplementation((event) => ({ data: event }));
  mocks.settingsFindUnique.mockResolvedValue(STORED);
  mocks.settingsUpsert.mockImplementation(async (args) => upsertEcho(args));
  mocks.pageContentFindUnique.mockResolvedValue({ published: true });
  mocks.auditCreate.mockResolvedValue({});
  mocks.transaction.mockImplementation(async (cb) =>
    cb({
      analyticsSettings: {
        findUnique: mocks.settingsFindUnique,
        upsert: mocks.settingsUpsert,
      },
      auditLog: { create: mocks.auditCreate },
    }),
  );
});

describe("permissions", () => {
  it("requires finance:view to read", async () => {
    await GET();
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("requires finance:edit to write", async () => {
    await PUT(putRequest(validBody()));
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
  });

  it("requires finance:edit to ask visitors to choose again", async () => {
    await RECONSENT(reconsentRequest());
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
  });

  it.each([
    ["GET", async () => GET()],
    ["PUT", async () => PUT(putRequest(validBody()))],
    ["POST reconsent", async () => RECONSENT(reconsentRequest())],
  ])("returns the guard's refusal for %s without touching storage", async (
    _label,
    call,
  ) => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });

    expect((await call()).status).toBe(403);
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicSite).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("returns the settings, the four-state status, the suggested wording and the privacy page state", async () => {
    const body = await (await GET()).json();

    expect(body.settings.measurementId).toBe("G-OLD1234567");
    expect(body.status).toBe("configured_with_banner");
    expect(body.defaultBannerMessage).toBe(DEFAULT_ANALYTICS_BANNER_MESSAGE);
    expect(body.privacyPolicy).toMatchObject({
      exists: true,
      published: true,
      publicPath: "/privacy",
      adminHref: "/admin/page-content",
    });
  });

  it("reports a missing privacy policy without failing the read", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(null);
    const body = await (await GET()).json();
    expect(body.privacyPolicy).toMatchObject({ exists: false, published: false });
  });

  it("reports the privacy policy as unpublished when the read itself fails", async () => {
    // Fail-closed for a prompt whose job is to remind an admin to disclose.
    mocks.pageContentFindUnique.mockRejectedValue(new Error("db down"));
    const body = await (await GET()).json();
    expect(body.privacyPolicy).toMatchObject({ exists: false, published: false });
  });

  it("synthesises the defaults when no row is stored", async () => {
    mocks.settingsFindUnique.mockResolvedValue(null);
    const body = await (await GET()).json();
    expect(body.status).toBe("setup_required");
    expect(body.settings).toMatchObject({
      measurementId: null,
      consentBannerEnabled: true,
      consentRevision: 1,
    });
  });
});

describe("PUT validation", () => {
  it("refuses malformed JSON", async () => {
    const res = await PUT(putRequest(null, "{not json"));
    expect(res.status).toBe(400);
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
  });

  it("refuses unknown fields, so consentRevision can never be set through Save", async () => {
    const res = await PUT(
      putRequest(validBody({ consentRevision: 99 })),
    );
    expect(res.status).toBe(400);
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["a Google Tag Manager container", "GTM-ABCDEF"],
    ["a Universal Analytics property", "UA-1234-5"],
    ["a bare stream id", "ABCDE12345"],
  ])("refuses %s with a field-tagged error", async (_label, measurementId) => {
    const res = await PUT(putRequest(validBody({ measurementId })));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.field).toBe("measurementId");
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicSite).not.toHaveBeenCalled();
  });

  it("refuses an empty banner message while the banner is ON", async () => {
    const res = await PUT(
      putRequest(validBody({ bannerMessage: "   ", consentBannerEnabled: true })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("bannerMessage");
  });
});

describe("PUT persistence", () => {
  it("trims the measurement ID and stores the acting admin", async () => {
    await PUT(putRequest(validBody({ measurementId: "  G-NEW1234567  " })));

    expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          measurementId: "G-NEW1234567",
          updatedByMemberId: "admin-1",
        }),
      }),
    );
  });

  it("clears the measurement ID when the field is submitted empty", async () => {
    // Clearing the box is how an admin switches analytics off.
    await PUT(putRequest(validBody({ measurementId: "" })));
    expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ measurementId: null }),
      }),
    );
  });

  it("keeps the stored wording when an empty message arrives with the banner OFF", async () => {
    await PUT(
      putRequest({
        measurementId: "G-NEW1234567",
        consentBannerEnabled: false,
        bannerMessage: "",
      }),
    );
    expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ bannerMessage: "Old wording." }),
      }),
    );
  });

  it("NEVER writes consentRevision — an ordinary Save must not re-prompt visitors", async () => {
    await PUT(putRequest(validBody({ bannerMessage: "Reworded entirely." })));

    const call = mocks.settingsUpsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(call.update).not.toHaveProperty("consentRevision");
  });

  it("reads and writes inside one transaction, so the audit before/after is real", async () => {
    await PUT(putRequest(validBody()));
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("audits the change with the actor, and without the banner wording", async () => {
    await PUT(
      putRequest(
        validBody({
          measurementId: "G-NEW1234567",
          consentBannerEnabled: false,
          bannerMessage: "Brand new wording nobody should find in an audit row.",
        }),
      ),
    );

    const event = mocks.buildAudit.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      action: "ANALYTICS_SETTINGS_UPDATED",
      actor: { memberId: "admin-1" },
      entity: { type: "AnalyticsSettings", id: "default" },
      outcome: "success",
    });
    expect(event.metadata).toMatchObject({
      previousMeasurementId: "G-OLD1234567",
      newMeasurementId: "G-NEW1234567",
      previousConsentBannerEnabled: true,
      newConsentBannerEnabled: false,
      bannerMessageChanged: true,
    });
    expect(JSON.stringify(event.metadata)).not.toContain(
      "nobody should find in an audit row",
    );
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
  });

  it("records a consent-mode change even when nothing else moved", async () => {
    await PUT(
      putRequest(
        validBody({
          measurementId: STORED.measurementId,
          consentBannerEnabled: false,
          bannerMessage: STORED.bannerMessage,
        }),
      ),
    );
    expect(mocks.buildAudit.mock.calls[0]?.[0].metadata).toMatchObject({
      previousConsentBannerEnabled: true,
      newConsentBannerEnabled: false,
      bannerMessageChanged: false,
    });
  });

  it("invalidates the public configuration cache so no stale tag survives", async () => {
    await PUT(putRequest(validBody({ measurementId: "" })));
    expect(mocks.revalidatePublicSite).toHaveBeenCalledWith(
      PUBLIC_LAYOUT_CACHE_TAGS.analytics,
    );
  });

  it("echoes the SERVER's normalised values back for the form to re-seed from", async () => {
    const body = await (
      await PUT(putRequest(validBody({ measurementId: " G-NEW1234567 " })))
    ).json();

    expect(body.settings.measurementId).toBe("G-NEW1234567");
    expect(body.status).toBe("configured_with_banner");
  });
});

describe("POST reconsent — the explicit re-consent action", () => {
  it("increments the consent revision and audits it with the actor", async () => {
    const res = await RECONSENT(reconsentRequest());

    expect(res.status).toBe(200);
    expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          consentRevision: 4,
          updatedByMemberId: "admin-1",
        }),
      }),
    );
    const event = mocks.buildAudit.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      action: "ANALYTICS_CONSENT_REVISION_BUMPED",
      actor: { memberId: "admin-1" },
    });
    expect(event.metadata).toMatchObject({
      previousConsentRevision: 3,
      newConsentRevision: 4,
    });
  });

  it("does not change the measurement ID, the banner mode or the wording", async () => {
    await RECONSENT(reconsentRequest());
    const call = mocks.settingsUpsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(Object.keys(call.update).sort()).toEqual([
      "consentRevision",
      "updatedByMemberId",
    ]);
  });

  it("clears the public cache, or a stored page would keep handing out the old revision", async () => {
    await RECONSENT(reconsentRequest());
    expect(mocks.revalidatePublicSite).toHaveBeenCalledWith(
      PUBLIC_LAYOUT_CACHE_TAGS.analytics,
    );
  });

  it("refuses with 409 while the banner is OFF, even from a stale tab", async () => {
    // Owner clarification 2: there is no prompt to show in banner-off mode, so a bump
    // could only discard a preference a visitor set deliberately.
    mocks.settingsFindUnique.mockResolvedValue({
      ...STORED,
      consentBannerEnabled: false,
    });

    const res = await RECONSENT(reconsentRequest());

    expect(res.status).toBe(409);
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicSite).not.toHaveBeenCalled();
  });

  it("starts a lazily-created singleton at revision 2", async () => {
    mocks.settingsFindUnique.mockResolvedValue(null);
    await RECONSENT(reconsentRequest());
    expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ consentRevision: 2 }),
      }),
    );
  });
});
