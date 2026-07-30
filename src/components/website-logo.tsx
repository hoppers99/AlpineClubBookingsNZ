import { cn } from "@/lib/utils";

type WebsiteLogoProps = {
  label: string;
  /** Served-image logo (`/api/images/<id>`). Preferred over `logoDataUrl`. */
  logoUrl?: string | null;
  logoDataUrl?: string | null;
  className?: string;
  textClassName?: string;
};

export function WebsiteLogo({
  label,
  logoUrl,
  logoDataUrl,
  className,
  textClassName,
}: WebsiteLogoProps) {
  // #2322: URL first — it is a short, immutably-cached reference instead of up
  // to ~1.2MB of base64 inlined at every render site. The data URI remains the
  // fallback for deployments whose logo has not been re-uploaded yet.
  //
  // `||`, not `??`: an empty string must fall through to the next source rather
  // than render an empty `src` (which would resolve to the current page URL).
  const src = logoUrl || logoDataUrl;

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={label}
        className={cn("h-10 w-auto object-contain", className)}
      />
    );
  }

  return (
    <span
      data-website-heading="true"
      className={cn("font-heading text-lg font-bold leading-tight", textClassName)}
    >
      {label}
    </span>
  );
}
