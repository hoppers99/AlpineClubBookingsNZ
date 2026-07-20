"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, Loader2, Trash2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { memberPhotoServingUrl } from "@/lib/member-photo-url";
import {
  clampOffset,
  computeSourceRect,
  coverBaseScale,
  type Offset,
  type Size,
} from "@/lib/member-photo-crop";

const VIEWPORT = 256;
const OUTPUT = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
// The upload endpoint (MP2) re-encodes and enforces the real caps; these are
// friendly client-side pre-checks so a member is told immediately rather than
// after a failed round-trip. The source cap is generous because the crop is
// downscaled to OUTPUT px before upload.
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const OUTPUT_TYPE = "image/jpeg";
const OUTPUT_QUALITY = 0.9;

interface ProfilePhotoSectionProps {
  memberId: string;
  memberName: string;
  initialHasPhoto: boolean;
  initialPhotoVersion: string | null;
}

interface LoadedSource {
  readonly image: HTMLImageElement;
  readonly natural: Size;
  readonly objectUrl: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

/**
 * Member self-service profile photo (epic #171, MP3). Upload with an in-browser
 * circular zoom/crop guide (owner decision 7), replace, and remove — all via
 * the member-scoped MP2 endpoints. The crop is downscaled to a square OUTPUT px
 * canvas client-side; the server re-encodes, so the UI never assumes final
 * dimensions. Display crops to a circle via CSS; the stored image is the square
 * bounding box of the guide.
 */
export function ProfilePhotoSection({
  memberId,
  memberName,
  initialHasPhoto,
  initialPhotoVersion,
}: ProfilePhotoSectionProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });

  const [hasPhoto, setHasPhoto] = useState(initialHasPhoto);
  const [version, setVersion] = useState<string | null>(initialPhotoVersion);
  const [source, setSource] = useState<LoadedSource | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  const baseScale = source ? coverBaseScale(source.natural, VIEWPORT) : 1;
  const scale = baseScale * zoom;
  const dialogOpen = source !== null;

  const releaseSource = useCallback((current: LoadedSource | null) => {
    if (current) URL.revokeObjectURL(current.objectUrl);
  }, []);

  // Revoke the last object URL when the component unmounts.
  useEffect(() => {
    return () => {
      if (source) URL.revokeObjectURL(source.objectUrl);
    };
  }, [source]);

  // Redraw the preview whenever the framing changes.
  useEffect(() => {
    if (!source) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, VIEWPORT, VIEWPORT);
    ctx.drawImage(
      source.image,
      offset.x,
      offset.y,
      source.natural.width * scale,
      source.natural.height * scale,
    );
  }, [source, offset, scale]);

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file later.
    event.target.value = "";
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error("Please choose a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      toast.error("That image is too large. Please choose one under 25MB.");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const natural = { width: image.naturalWidth, height: image.naturalHeight };
      if (natural.width < 1 || natural.height < 1) {
        URL.revokeObjectURL(objectUrl);
        toast.error("That image could not be read.");
        return;
      }
      const nextBase = coverBaseScale(natural, VIEWPORT);
      setSource((prev) => {
        releaseSource(prev);
        return { image, natural, objectUrl };
      });
      setZoom(MIN_ZOOM);
      // Centre the image within the covered viewport.
      setOffset(clampOffset({ x: 0, y: 0 }, natural, VIEWPORT, nextBase));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      toast.error("That image could not be read.");
    };
    image.src = objectUrl;
  }

  function closeDialog() {
    setSource((prev) => {
      releaseSource(prev);
      return null;
    });
  }

  function handleZoomChange(nextZoom: number) {
    if (!source) return;
    const nextScale = baseScale * nextZoom;
    setZoom(nextZoom);
    setOffset((current) =>
      clampOffset(current, source.natural, VIEWPORT, nextScale),
    );
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!source) return;
    dragRef.current = {
      active: true,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!source || !dragRef.current.active) return;
    const dx = event.clientX - dragRef.current.lastX;
    const dy = event.clientY - dragRef.current.lastY;
    dragRef.current.lastX = event.clientX;
    dragRef.current.lastY = event.clientY;
    setOffset((current) =>
      clampOffset(
        { x: current.x + dx, y: current.y + dy },
        source.natural,
        VIEWPORT,
        scale,
      ),
    );
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function handleSave() {
    if (!source) return;
    setSubmitting(true);
    try {
      const rect = computeSourceRect(source.natural, VIEWPORT, scale, offset);
      const out = document.createElement("canvas");
      out.width = OUTPUT;
      out.height = OUTPUT;
      const octx = out.getContext("2d");
      if (!octx) {
        toast.error("Your browser could not process the image.");
        return;
      }
      octx.drawImage(
        source.image,
        rect.sx,
        rect.sy,
        rect.sWidth,
        rect.sHeight,
        0,
        0,
        OUTPUT,
        OUTPUT,
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        out.toBlob(resolve, OUTPUT_TYPE, OUTPUT_QUALITY),
      );
      if (!blob) {
        toast.error("Your browser could not process the image.");
        return;
      }

      const formData = new FormData();
      formData.append("file", blob, "photo.jpg");
      const res = await fetch(memberPhotoServingUrl(memberId), {
        method: "POST",
        body: formData,
      });
      const data = (await res.json().catch(() => ({}))) as {
        updatedAt?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error || "Your photo could not be saved.");
        return;
      }
      setHasPhoto(true);
      setVersion(data.updatedAt ?? new Date().toISOString());
      closeDialog();
      toast.success("Profile photo updated.");
      router.refresh();
    } catch {
      toast.error("Your photo could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      const res = await fetch(memberPhotoServingUrl(memberId), {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error || "Your photo could not be removed.");
        return;
      }
      setHasPhoto(false);
      setVersion(null);
      setShowRemoveConfirm(false);
      toast.success("Profile photo removed.");
      router.refresh();
    } catch {
      toast.error("Your photo could not be removed.");
    } finally {
      setRemoving(false);
    }
  }

  const currentPhotoUrl = hasPhoto
    ? memberPhotoServingUrl(memberId, version)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div
          className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-lg font-semibold text-muted-foreground"
          aria-hidden={currentPhotoUrl ? undefined : true}
        >
          {currentPhotoUrl ? (
            // Plain <img>: the source is an authenticated, no-store endpoint, so
            // it must bypass the image optimiser.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={currentPhotoUrl}
              alt={`${memberName}'s profile photo`}
              width={80}
              height={80}
              className="h-full w-full object-cover"
            />
          ) : (
            <span>{initials(memberName)}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={openFilePicker} variant="outline">
            {hasPhoto ? (
              <Camera className="h-4 w-4" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            {hasPhoto ? "Change photo" : "Add photo"}
          </Button>
          {hasPhoto ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowRemoveConfirm(true)}
              disabled={removing}
            >
              <Trash2 className="h-4 w-4" />
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Your photo is shown to you here and, if you are on the committee, on the
        public committee page. JPEG, PNG or WebP.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        onChange={handleFileChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Frame your photo</DialogTitle>
            <DialogDescription>
              Drag to reposition and use the zoom slider. The area inside the
              circle is what others will see.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4">
            <div
              className="relative touch-none"
              style={{ width: VIEWPORT, height: VIEWPORT }}
            >
              <canvas
                ref={canvasRef}
                width={VIEWPORT}
                height={VIEWPORT}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className="cursor-move rounded-md bg-muted"
                role="img"
                aria-label="Photo crop preview. Drag to reposition."
              />
              {/* Circular framing guide: darkens the area outside the circle. */}
              <div
                className="pointer-events-none absolute inset-0 rounded-full"
                style={{ boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)" }}
                aria-hidden="true"
              />
              <div
                className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/70"
                aria-hidden="true"
              />
            </div>
            <div className="w-full space-y-1">
              <Label htmlFor="profile-photo-zoom">Zoom</Label>
              <input
                id="profile-photo-zoom"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                value={zoom}
                onChange={(event) =>
                  handleZoomChange(Number(event.target.value))
                }
                className="w-full"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {submitting ? "Saving..." : "Save photo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showRemoveConfirm}
        onOpenChange={(open) => {
          if (!open) setShowRemoveConfirm(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove your photo?</DialogTitle>
            <DialogDescription>
              Your profile photo will be deleted. If you are on the committee,
              the committee page will fall back to no photo.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowRemoveConfirm(false)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleRemove}
              disabled={removing}
            >
              {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {removing ? "Removing..." : "Remove photo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
