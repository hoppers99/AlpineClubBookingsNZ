export const CSP_HEADER = "Content-Security-Policy";
// test seam
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
export const CSP_NONCE_HEADER = "x-nonce";

// test seam
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
} as const;

export function createCspNonce() {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export interface CspOptions {
  /** The request pathname — a couple of routes carry a scoped relaxation. */
  pathname?: string;
  /**
   * The request's own origin (scheme://host[:port]). The sandboxed template
   * preview (LTV-036) frames /display with an OPAQUE origin, where `connect-src
   * 'self'` matches nothing; adding the concrete origin lets the framed document
   * still reach /api/display/state.
   */
  selfOrigin?: string;
}

export function setSecurityHeaders(headers: Headers, pathname?: string) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  // /display may be embedded in the same-origin sandboxed template preview
  // (LTV-036, ADR-003 §5). SAMEORIGIN keeps third-party clickjacking blocked
  // while letting our own admin preview host frame it; every other route keeps
  // the global DENY.
  if (pathname === "/display") {
    headers.set("X-Frame-Options", "SAMEORIGIN");
  }
}

/**
 * Admin pages that EMBED the sandboxed /display iframe, and so need
 * `frame-src 'self'`: the Templates preview host (LTV-036, ADR-003 §5) and the
 * Visual builder's Live preview (ADR-004 §7, issue #2246).
 *
 * Matched by EXACT equality, never by prefix — a prefix match would silently
 * hand `frame-src 'self'` to `/admin/display/templates` and every future
 * `/admin/display/*` page, which is precisely the blanket relaxation the scoped
 * design avoids.
 */
const FRAME_SRC_SELF_PATHS: readonly string[] = [
  "/admin/display/preview",
  "/admin/display/builder",
];

/**
 * Routes whose img-src drops the `https:` wildcard (issue #161, ADR-003
 * residual): admin-authored display HTML/CSS can embed an <img>, and the global
 * img-src otherwise allows any https host — an authoring admin could exfiltrate
 * the display's own token values (config, occupancy, …) via an image-beacon
 * `src`. These are the routes that RENDER authored display markup: /display
 * itself, and the minimal preview host whose whole body is that iframe.
 *
 * Deliberately NOT the Visual builder: it is a full admin page inside the admin
 * chrome (avatars, uploaded images, the rest of the admin UI), not a sandboxed
 * display document, so dropping `blob:`/`https:` there would break unrelated
 * admin imagery for no gain — the authored markup it previews runs in the
 * opaque-origin /display frame, which carries the tightened policy itself.
 * Exact equality only, for the same reason as above.
 */
const TIGHT_IMG_SRC_PATHS: readonly string[] = [
  "/display",
  "/admin/display/preview",
];

export function buildContentSecurityPolicy(nonce: string, options: CspOptions = {}) {
  const isDev = process.env.NODE_ENV === "development";
  const { pathname, selfOrigin } = options;

  // Scoped relaxations for the sandboxed display preview (LTV-036, ADR-004 §7):
  //  • /display: frame-ancestors 'self' so our own admin preview surfaces can
  //    frame it (every other route stays 'none'), and connect-src gains this
  //    site's explicit origin so the opaque-origin framed document can still
  //    fetch the state API.
  //  • the FRAME_SRC_SELF_PATHS hosts: frame-src 'self' so they may embed the
  //    /display iframe.
  //  • the TIGHT_IMG_SRC_PATHS routes: a tighter img-src (see above).
  // The frame-src and img-src sets are deliberately SEPARATE lists: framing
  // /display and rendering authored display markup are unrelated needs, and one
  // shared boolean would force every new preview host to accept the tightened
  // img-src as the price of an iframe.
  const isDisplay = pathname === "/display";
  const framesDisplay = pathname !== undefined && FRAME_SRC_SELF_PATHS.includes(pathname);
  const tightensImgSrc = pathname !== undefined && TIGHT_IMG_SRC_PATHS.includes(pathname);
  // `blob:` is required for the member-photo crop UI (epic #171): it previews the
  // locally-selected file by loading its `URL.createObjectURL(...)` blob into an
  // <img>. blob: URLs are same-origin and page-created — no exfiltration vector,
  // unlike the `https:` wildcard the display route deliberately drops.
  const imgSrc = tightensImgSrc
    ? "img-src 'self' data:"
    : "img-src 'self' data: blob: https: https://www.google-analytics.com https://*.google-analytics.com";

  const directives = [
    "default-src 'self'",
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      ...(isDev ? ["'unsafe-eval'"] : []),
      "https://js.stripe.com",
      "https://www.googletagmanager.com",
    ].join(" "),
    // Keep inline styles during the script nonce rollout; Tailwind/Radix and
    // selected editor-rendered content can still emit runtime style attributes.
    "style-src 'self' 'unsafe-inline'",
    imgSrc,
    "font-src 'self' data:",
    [
      "connect-src",
      "'self'",
      ...(isDisplay && selfOrigin ? [selfOrigin] : []),
      "https://api.stripe.com",
      "https://js.stripe.com",
      "https://*.ingest.sentry.io",
      "https://www.google-analytics.com",
      "https://*.google-analytics.com",
    ].join(" "),
    [
      "frame-src",
      ...(framesDisplay ? ["'self'"] : []),
      "https://js.stripe.com",
      "https://hooks.stripe.com",
    ].join(" "),
    "worker-src 'self' blob:",
    "object-src 'none'",
    isDisplay ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  return directives.join("; ");
}
