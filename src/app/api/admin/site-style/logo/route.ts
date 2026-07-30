import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { logAudit } from "@/lib/audit";
import { readCappedMultipartFormData } from "@/lib/capped-multipart";
import logger from "@/lib/logger";
import {
  MAX_MEDIA_IMAGE_BYTES,
  MAX_MEDIA_IMAGE_REQUEST_BYTES,
  detectImageContentType,
  mediaImageServingUrl,
  sanitiseMediaImageFilename,
} from "@/lib/media-image";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * Club-logo upload (#2322).
 *
 * Replaces the wizard's old `FileReader.readAsDataURL` flow, which inlined up
 * to ~1.2MB of base64 into every public page render. The upload is re-encoded
 * server-side to a small image and stored as a `MediaImage`, so the page ships
 * a short `/api/images/<id>` reference that `api/images/[id]` serves with
 * `public, max-age=31536000, immutable`.
 *
 * This is a separate route rather than a mode on `POST /api/admin/image-library`
 * on purpose: that endpoint deliberately stores uploads byte-for-byte for the
 * content picker, and resizing there would silently degrade every content
 * image. Only the storage layer is shared.
 */

/** The logo renders at 40px tall; 160 covers 4x-density displays. */
const MAX_LOGO_HEIGHT_PX = 160;
/**
 * Height alone does not bound the pixel count: a 120000x40 banner passes a
 * height-only resize untouched. 640 is 4x the 160px (`max-w-40`) box the logo
 * actually renders in.
 */
const MAX_LOGO_WIDTH_PX = 640;

/**
 * SVG is excluded even though the shared `MediaImage` allowlist permits it:
 * sharp would rasterise it through librsvg on admin-supplied input, and the
 * image-manager route already refuses SVG for stored-XSS reasons. AVIF is
 * excluded too — the legacy logo validator never accepted it, so nothing is
 * lost by keeping the input set identical to the data-URI path.
 */
const ACCEPTED_SOURCE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type EncodedLogo = { data: Buffer; contentType: string; extension: string };

/**
 * Re-encode to WebP, falling back to PNG if WebP encoding fails for this
 * source. Transparency survives both. An animated source collapses to its
 * first frame, which is the correct treatment for a site logo.
 */
async function encodeLogo(source: Buffer): Promise<EncodedLogo | null> {
  const resized = sharp(source).resize({
    width: MAX_LOGO_WIDTH_PX,
    height: MAX_LOGO_HEIGHT_PX,
    withoutEnlargement: true,
    fit: "inside",
  });

  try {
    return {
      data: await resized.clone().webp({ quality: 90 }).toBuffer(),
      contentType: "image/webp",
      extension: "webp",
    };
  } catch (error) {
    logger.warn({ err: error }, "Logo WebP encode failed; falling back to PNG");
  }

  try {
    return {
      data: await resized.clone().png({ compressionLevel: 9 }).toBuffer(),
      contentType: "image/png",
      extension: "png",
    };
  } catch (error) {
    logger.error({ err: error }, "Logo PNG fallback encode failed");
    return null;
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  // Streamed cap: an oversize or spoofed-Content-Length body is cut off
  // mid-stream rather than buffered in full (same contract as the image
  // library upload).
  const multipart = await readCappedMultipartFormData(request, {
    maxRequestBytes: MAX_MEDIA_IMAGE_REQUEST_BYTES,
    maxFileBytes: MAX_MEDIA_IMAGE_BYTES,
    maxFiles: 1,
  });
  if (!multipart.ok) {
    return multipart.reason === "too_large"
      ? NextResponse.json(
          { error: "Logo exceeds the 2MB upload limit." },
          { status: 413 },
        )
      : NextResponse.json(
          { error: "Invalid multipart/form-data body." },
          { status: 400 },
        );
  }

  const file = multipart.formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "A file field containing the logo is required." },
      { status: 400 },
    );
  }

  const source = Buffer.from(await file.arrayBuffer());

  // Belt-and-braces recheck after buffering: the streamed cap above is the real
  // guard, but every multipart route in this repo re-checks the materialised
  // size rather than trusting the stream alone.
  if (source.length > MAX_MEDIA_IMAGE_BYTES) {
    return NextResponse.json(
      { error: "Logo exceeds the 2MB upload limit." },
      { status: 413 },
    );
  }

  // Trust the bytes, never the declared Content-Type or the extension.
  const sourceType = detectImageContentType(source);
  if (!sourceType || !ACCEPTED_SOURCE_TYPES.has(sourceType)) {
    return NextResponse.json(
      { error: "Logo must be a PNG, JPEG, WebP, or GIF image." },
      { status: 400 },
    );
  }

  const encoded = await encodeLogo(source);
  if (!encoded) {
    return NextResponse.json(
      { error: "Logo could not be processed. Try a different image." },
      { status: 400 },
    );
  }

  // A pathological source can still encode large (huge canvas, noisy content).
  // Gate the STORED bytes, mirroring the image-library cap.
  if (encoded.data.length > MAX_MEDIA_IMAGE_BYTES) {
    return NextResponse.json(
      { error: "Logo is too complex to store. Try a simpler or smaller image." },
      { status: 413 },
    );
  }

  const dimensions = await sharp(encoded.data)
    .metadata()
    .then((meta) => ({ width: meta.width ?? null, height: meta.height ?? null }))
    .catch(() => ({ width: null, height: null }));

  const baseName =
    sanitiseMediaImageFilename(file.name || "logo").replace(/\.[^.]*$/, "") ||
    "logo";

  const image = await prisma.mediaImage.create({
    data: {
      filename: `${baseName}.${encoded.extension}`,
      contentType: encoded.contentType,
      byteSize: encoded.data.length,
      data: new Uint8Array(encoded.data),
      width: dimensions.width,
      height: dimensions.height,
      uploadedByMemberId: session.user.id,
      // LOGO is publicly served like CONTENT but stays out of the content
      // picker, and lets the theme own this blob's lifecycle: replacing or
      // clearing the logo deletes exactly the prior LOGO row (#2322).
      kind: "LOGO",
    },
    select: { id: true, byteSize: true, width: true, height: true },
  });

  logAudit({
    action: "site_style.logo_uploaded",
    memberId: session.user.id,
    targetId: image.id,
    entityType: "MediaImage",
    entityId: image.id,
    category: "admin",
    outcome: "success",
    summary: "Uploaded a club logo",
    metadata: {
      contentType: encoded.contentType,
      sourceContentType: sourceType,
      sourceByteSize: source.length,
      byteSize: image.byteSize,
      width: image.width,
      height: image.height,
    },
  });

  return NextResponse.json(
    {
      logoUrl: mediaImageServingUrl(image.id),
      byteSize: image.byteSize,
      width: image.width,
      height: image.height,
    },
    { status: 201 },
  );
}
