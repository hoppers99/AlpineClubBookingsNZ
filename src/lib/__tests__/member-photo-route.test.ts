import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  memberFindUnique: vi.fn(),
  memberUpdate: vi.fn(),
  mediaImageFindUnique: vi.fn(),
  mediaImageCreate: vi.fn(),
  mediaImageDeleteMany: vi.fn(),
  txQueryRaw: vi.fn(),
  transaction: vi.fn(),
  logAudit: vi.fn(),
}));

// The committee-public ETag is an opaque digest of the image id + last-updated
// timestamp — never the raw MediaImage id (which used to leak to anonymous
// callers). Mirror the route's derivation so tests assert the exact value.
const PHOTO_UPDATED_AT = new Date("2026-07-01T00:00:00.000Z");
function committeeEtag(photoImageId: string, updatedAt: Date | null): string {
  return `"${createHash("sha256")
    .update(`${photoImageId}:${updatedAt?.toISOString() ?? ""}`)
    .digest("hex")
    .slice(0, 32)}"`;
}

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async (options?: unknown) =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(
      options as never,
    ),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
      update: mocks.memberUpdate,
    },
    mediaImage: {
      findUnique: mocks.mediaImageFindUnique,
      create: mocks.mediaImageCreate,
      deleteMany: mocks.mediaImageDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST, DELETE } from "@/app/api/members/[id]/photo/route";

const TARGET_ID = "member-target";

const ownerSession = {
  user: { id: TARGET_ID, role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const otherMemberSession = {
  user: { id: "member-other", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const membershipAdminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const readonlyAdminSession = {
  user: {
    id: "admin-ro",
    role: "ADMIN",
    accessRoles: [{ role: "ADMIN_READONLY" }],
  },
};

const PNG_BYTES = (() => {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(64, 16);
  buf.writeUInt32BE(32, 20);
  return buf;
})();

const GIF_BYTES = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");

const WEBP_BYTES = (() => {
  const buf = Buffer.alloc(16);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(8, 4);
  buf.write("WEBP", 8, "ascii");
  return buf;
})();

// A VP8X WebP declaring a 16384×16384 canvas (> MAX_MEMBER_PHOTO_DIMENSION):
// small on disk, a ~1GB decode bomb in the browser.
const OVERSIZED_WEBP_BYTES = (() => {
  const payload = Buffer.alloc(10); // 4 flags/reserved + 3 (w-1) + 3 (h-1)
  payload.writeUIntLE(16383, 4, 3);
  payload.writeUIntLE(16383, 7, 3);
  const buf = Buffer.alloc(20 + payload.length);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(4 + 8 + payload.length, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(payload.length, 16);
  payload.copy(buf, 20);
  return buf;
})();

/**
 * Wire prisma.member.findUnique to answer each of the route's three distinct
 * selects: the GET committee/photo lookup, the GET private-branch viewer
 * lookup, and the POST/DELETE target lookup.
 */
function wireMemberLookups({
  photoImageId,
  committeePublished,
  memberActive = true,
  viewer,
}: {
  photoImageId: string | null;
  committeePublished?: boolean;
  memberActive?: boolean;
  viewer?: { active: boolean; accessRoles: Array<{ role: string }> } | null;
}) {
  mocks.memberFindUnique.mockImplementation(
    async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => {
      if (select.committeeAssignments) {
        if (photoImageId === null) {
          return {
            active: memberActive,
            photoImageId: null,
            photoUpdatedAt: PHOTO_UPDATED_AT,
            committeeAssignments: [],
          };
        }
        return {
          active: memberActive,
          photoImageId,
          photoUpdatedAt: PHOTO_UPDATED_AT,
          committeeAssignments: committeePublished ? [{ id: "ca-1" }] : [],
        };
      }
      if (select.accessRoles) {
        return viewer ?? null;
      }
      // POST/DELETE target lookup.
      return where.id === TARGET_ID ? { id: TARGET_ID } : null;
    },
  );
  // The upload/remove transaction re-reads the current pointer under a row lock
  // (SELECT ... FOR UPDATE) instead of trusting the pre-transaction read, so a
  // concurrent replace can't orphan a blob. Mirror the current pointer here.
  mocks.txQueryRaw.mockResolvedValue([{ photoImageId }]);
}

function servingRequest(id: string, headers?: Record<string, string>) {
  return new NextRequest(`http://localhost/api/members/${id}/photo`, { headers });
}

function uploadRequest(id: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return new NextRequest(`http://localhost/api/members/${id}/photo`, {
    method: "POST",
    body: formData,
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(null);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.mediaImageFindUnique.mockResolvedValue({
    data: PNG_BYTES,
    contentType: "image/png",
  });
  mocks.mediaImageCreate.mockImplementation(async ({ data }) => ({
    id: "img-new",
    contentType: data.contentType,
    byteSize: data.byteSize,
  }));
  mocks.mediaImageDeleteMany.mockResolvedValue({ count: 1 });
  mocks.memberUpdate.mockResolvedValue({});
  mocks.txQueryRaw.mockResolvedValue([{ photoImageId: null }]);
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      $queryRaw: mocks.txQueryRaw,
      mediaImage: {
        create: mocks.mediaImageCreate,
        deleteMany: mocks.mediaImageDeleteMany,
      },
      member: { update: mocks.memberUpdate },
    }),
  );
});

describe("GET /api/members/[id]/photo — serving authz matrix", () => {
  it("serves a committee-published member's photo to an anonymous fetch (public cache)", async () => {
    wireMemberLookups({ photoImageId: "img-1", committeePublished: true });

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, must-revalidate",
    );
    // Opaque digest, never the raw MediaImage id (defence against id leakage).
    expect(response.headers.get("ETag")).toBe(
      committeeEtag("img-1", PHOTO_UPDATED_AT),
    );
    expect(response.headers.get("ETag")).not.toBe('"img-1"');
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.equals(PNG_BYTES)).toBe(true);
  });

  it("returns 304 for a committee photo when If-None-Match matches", async () => {
    wireMemberLookups({ photoImageId: "img-1", committeePublished: true });

    const response = await GET(
      servingRequest(TARGET_ID, {
        "if-none-match": committeeEtag("img-1", PHOTO_UPDATED_AT),
      }),
      params(TARGET_ID),
    );

    expect(response.status).toBe(304);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("returns 404 to an anonymous fetch for a non-published member", async () => {
    wireMemberLookups({ photoImageId: "img-1", committeePublished: false });

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(404);
    expect(mocks.mediaImageFindUnique).not.toHaveBeenCalled();
  });

  it("returns 404 to an anonymous fetch for a deactivated member holding a stale published assignment", async () => {
    // Lockstep with /api/committee (member: { active: true }): a deactivated
    // member is absent from the committee page, so their photo must not be
    // publicly servable even if a published assignment lingers.
    wireMemberLookups({
      photoImageId: "img-1",
      committeePublished: true,
      memberActive: false,
    });

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(404);
    expect(mocks.mediaImageFindUnique).not.toHaveBeenCalled();
  });

  it("serves a private photo to the owning member (no-store)", async () => {
    wireMemberLookups({ photoImageId: "img-1", committeePublished: false });
    mocks.auth.mockResolvedValue(ownerSession);

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it("returns 404 to a different, non-admin member for a private photo", async () => {
    wireMemberLookups({
      photoImageId: "img-1",
      committeePublished: false,
      viewer: { active: true, accessRoles: [{ role: "USER" }] },
    });
    mocks.auth.mockResolvedValue(otherMemberSession);

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(404);
    expect(mocks.mediaImageFindUnique).not.toHaveBeenCalled();
  });

  it("serves a private photo to a membership admin (no-store)", async () => {
    wireMemberLookups({
      photoImageId: "img-1",
      committeePublished: false,
      viewer: { active: true, accessRoles: [{ role: "ADMIN_READONLY" }] },
    });
    mocks.auth.mockResolvedValue(readonlyAdminSession);

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns 404 when the member has no photo", async () => {
    wireMemberLookups({ photoImageId: null });

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(404);
  });
});

describe("POST /api/members/[id]/photo — upload", () => {
  it("stamps kind=MEMBER_PHOTO, audit columns and photoImageId on a self-upload", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contentType: "image/png",
          kind: "MEMBER_PHOTO",
          uploadedByMemberId: TARGET_ID,
          width: 64,
          height: 32,
        }),
      }),
    );
    expect(mocks.memberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TARGET_ID },
        data: expect.objectContaining({
          photoImageId: "img-new",
          photoUpdatedByMemberId: TARGET_ID,
          photoUpdatedAt: expect.any(Date),
        }),
      }),
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member_photo.upload" }),
    );
  });

  it("accepts a WebP whose dimensions cannot be parsed (truncated header)", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([WEBP_BYTES], "me.webp", { type: "image/webp" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contentType: "image/webp",
          width: null,
          height: null,
        }),
      }),
    );
  });

  it("rejects an oversized-canvas VP8X WebP (decode-bomb backstop) with 400", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([OVERSIZED_WEBP_BYTES], "bomb.webp", {
      type: "image/webp",
    });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("cleans up the previous MEMBER_PHOTO blob when replacing", async () => {
    wireMemberLookups({ photoImageId: "old-img" });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalledWith({
      where: { id: "old-img", kind: "MEMBER_PHOTO" },
    });
  });

  it("rejects a disallowed image type (GIF) with 400", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([GIF_BYTES], "me.gif", { type: "image/gif" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects bytes that are not a recognised image with 400", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([Buffer.from("not an image")], "me.png", {
      type: "image/png",
    });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects an oversize file with 413", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(2 * 1024 * 1024)]);
    const file = new File([big], "big.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(413);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("blocks a member uploading to another member's id (IDOR) with 403", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(otherMemberSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(403);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("allows a membership-edit admin to upload on behalf of a member", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(membershipAdminSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadedByMemberId: "admin-1" }),
      }),
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member_photo.upload", subjectMemberId: TARGET_ID }),
    );
  });

  it("rejects a view-only admin (membership:edit required) with 403", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(readonlyAdminSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(403);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("requires a session (401) for an anonymous upload", async () => {
    wireMemberLookups({ photoImageId: null });

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(401);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/members/[id]/photo — remove", () => {
  it("clears the pointer and deletes the blob on a self-remove", async () => {
    wireMemberLookups({ photoImageId: "old-img" });
    mocks.auth.mockResolvedValue(ownerSession);

    const response = await DELETE(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(mocks.memberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          photoImageId: null,
          photoUpdatedByMemberId: TARGET_ID,
        }),
      }),
    );
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalledWith({
      where: { id: "old-img", kind: "MEMBER_PHOTO" },
    });
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member_photo.remove" }),
    );
  });

  it("is idempotent when the member has no photo", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const response = await DELETE(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(mocks.mediaImageDeleteMany).not.toHaveBeenCalled();
  });

  it("blocks a member removing another member's photo (IDOR) with 403", async () => {
    wireMemberLookups({ photoImageId: "old-img" });
    mocks.auth.mockResolvedValue(otherMemberSession);

    const response = await DELETE(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(403);
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
  });

  it("allows a membership-edit admin to remove on behalf of a member", async () => {
    wireMemberLookups({ photoImageId: "old-img" });
    mocks.auth.mockResolvedValue(membershipAdminSession);

    const response = await DELETE(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalled();
  });
});
