import { NextRequest } from "next/server";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  mediaImageCreate: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mediaImage: { create: mocks.mediaImageCreate },
    auditLog: { create: mocks.auditLogCreate },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/api/admin/site-style/logo/route";

/** A real PNG, so the content sniffer and sharp both see genuine bytes. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 30, b: 40, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

function uploadRequest(bytes: Buffer, filename = "club-logo.png") {
  const body = new FormData();
  body.append("file", new File([new Uint8Array(bytes)], filename), filename);

  return new NextRequest("http://localhost/api/admin/site-style/logo", {
    method: "POST",
    body,
  });
}

function allowAdmin() {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
}

describe("POST /api/admin/site-style/logo (#2322)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mediaImageCreate.mockImplementation(async ({ data }) => ({
      id: "img-new-1",
      byteSize: data.byteSize,
      width: data.width,
      height: data.height,
    }));
  });

  it("refuses a caller the admin guard rejects, without storing anything", async () => {
    const forbidden = new Response("nope", { status: 403 });
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: forbidden });

    const response = await POST(uploadRequest(await png(50, 50)));

    expect(response.status).toBe(403);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("stores a content-addressed image and returns its serving URL", async () => {
    allowAdmin();

    const response = await POST(uploadRequest(await png(400, 400)));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.logoUrl).toBe("/api/images/img-new-1");
    expect(mocks.mediaImageCreate).toHaveBeenCalledTimes(1);

    // LOGO is publicly served like CONTENT but stays out of the content picker
    // and lets the theme own the blob's lifecycle.
    const created = mocks.mediaImageCreate.mock.calls[0][0].data;
    expect(created.kind).toBe("LOGO");
    expect(created.uploadedByMemberId).toBe("admin-1");
  });

  it("resizes a large source down to the logo height bound and re-encodes to WebP", async () => {
    allowAdmin();

    const response = await POST(uploadRequest(await png(1200, 1000)));
    const payload = await response.json();
    const created = mocks.mediaImageCreate.mock.calls[0][0].data;

    expect(response.status).toBe(201);
    expect(created.contentType).toBe("image/webp");
    expect(created.filename.endsWith(".webp")).toBe(true);

    // The stored bytes really are bounded — assert on the encoded output, not
    // on what we asked sharp for.
    const meta = await sharp(Buffer.from(created.data)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.height).toBeLessThanOrEqual(160);
    // Aspect ratio preserved (1200x1000 -> 192x160).
    expect(meta.width).toBe(Math.round((1200 / 1000) * (meta.height ?? 0)));
    expect(payload.byteSize).toBe(created.byteSize);
  });

  it("does not enlarge a logo that is already smaller than the bound", async () => {
    allowAdmin();

    await POST(uploadRequest(await png(60, 40)));
    const created = mocks.mediaImageCreate.mock.calls[0][0].data;
    const meta = await sharp(Buffer.from(created.data)).metadata();

    expect(meta.height).toBe(40);
    expect(meta.width).toBe(60);
  });

  it("bounds a wide-short banner by width, not just height (#2322)", async () => {
    allowAdmin();

    // The measured attack: a 120000x40 PNG passes a height-only resize
    // untouched and gets stored byte-identical.
    await POST(uploadRequest(await png(4000, 40)));
    const created = mocks.mediaImageCreate.mock.calls[0][0].data;
    const meta = await sharp(Buffer.from(created.data)).metadata();

    expect(meta.width).toBeLessThanOrEqual(640);
    expect(meta.height).toBeLessThanOrEqual(160);
  });

  it("refuses an oversize source with 413", async () => {
    allowAdmin();
    const oversize = Buffer.concat([
      await png(10, 10),
      Buffer.alloc(2 * 1024 * 1024 + 1024, 0x00),
    ]);

    const response = await POST(uploadRequest(oversize));

    expect(response.status).toBe(413);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects bytes that are not a recognised image", async () => {
    allowAdmin();

    const response = await POST(
      uploadRequest(Buffer.from("this is definitely not an image"), "x.png"),
    );

    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects SVG even though the shared media allowlist permits it", async () => {
    allowAdmin();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );

    const response = await POST(uploadRequest(svg, "logo.svg"));

    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("requires a file field", async () => {
    allowAdmin();
    const body = new FormData();
    body.append("notAFile", "hello");

    const response = await POST(
      new NextRequest("http://localhost/api/admin/site-style/logo", {
        method: "POST",
        body,
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });
});
