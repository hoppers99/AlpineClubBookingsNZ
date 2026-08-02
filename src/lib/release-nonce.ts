/**
 * The ONE CSP script nonce every `(website)` page carries for the life of a
 * release (#2352, owner decision D1, 31 Jul 2026).
 *
 * ## Why a fixed nonce exists at all
 *
 * A stored page can only carry one nonce value. Next stamps the nonce into its
 * own inline bootstrap/RSC scripts at RENDER time, reading it from the request's
 * own `Content-Security-Policy` header
 * (`next/dist/server/app-render/app-render.js`). So the moment a public page is
 * served from the full-route ISR cache rather than re-rendered, the value frozen
 * into that stored HTML has to keep matching the policy on every later response,
 * or every inline script on the page is blocked and the page never hydrates.
 *
 * The two alternatives were measured and are not available (see the #2352
 * planning comment): the proxy cannot inject a nonce into a response BODY, and a
 * build-time hash list cannot cover Next's RSC payload scripts, whose contents
 * literally contain the rendered page and therefore change on every admin edit.
 *
 * ## What the trade actually costs
 *
 * The value is readable in the page source, so on those pages it no longer stops
 * a fully injected `<script>` tag. It still stops the commoner injection shapes
 * (`onclick=` handlers, `javascript:` URLs), and every other directive is
 * unchanged — `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
 * `frame-ancestors 'none'`, and no `unsafe-inline`. The only untrusted content on
 * these pages is admin-authored CMS HTML, allowlist-sanitised on write AND again
 * on read with no `script` and no `on*` attributes permitted. Recorded in full in
 * `docs/SECURITY-ATTACK-SURFACE.md`.
 *
 * Login, the member area, admin, finance, lodge and `/display` keep a fresh
 * per-request nonce, unchanged. `src/lib/csp.ts` owns that split.
 *
 * ## Why it is derived from a RELEASE identifier and not minted at boot
 *
 * The page cache is a per-container tmpfs (`docker-compose.yml`) wiped on
 * restart, so a stored page never outlives its own container. But a container can
 * have more than one reader — blue/green runs two, and a fork may run replicas —
 * and a per-process value would then differ between the process that STORED a
 * page and a process that SERVES it. Deriving from a value baked into the IMAGE
 * makes every reader of one release agree by construction, with no coordination.
 *
 * `RELEASE_ID` is a build ARG (`Dockerfile`), promoted to an ENV in BOTH the
 * builder and the runner stage on purpose: the builder ENV is what a bundle that
 * inlines `process.env` at build time would capture, the runner ENV is what a
 * runtime read sees, and setting both from the same ARG means the two can never
 * disagree. The runner stage also asserts the value is readable in the finished
 * image, so a Dockerfile that passed the ARG but forgot the ENV fails visibly
 * instead of silently falling back.
 *
 * ## The nonce is a DIGEST, not the identifier
 *
 * CI and the deploy runner both pass the commit SHA as `RELEASE_ID`. That value
 * is not secret, but it is not something a public page needs to publish either,
 * so the nonce is a SHA-256 of a namespaced string rather than the id itself.
 * Nothing about the deployed revision is recoverable from the page source.
 *
 * ## Fallback, stated rather than hidden
 *
 * With no release identifier readable — a bare `docker build`, or `next start` in
 * development — this falls back to ONE random value per process and logs it. That
 * keeps a single-process deployment self-consistent (its page cache is emptied by
 * the same restart that mints the new value), but it is NOT safe for a
 * multi-reader deployment, which is why the image asserts the identifier is
 * present and why `source` is exposed for tests and diagnostics.
 */

import { createCspNonce } from "@/lib/csp";
import logger from "@/lib/logger";

/**
 * The build ARG / ENV carrying the release identifier. Exported for the docs and
 * the tests; the reads below use the literal `process.env.RELEASE_ID` form
 * because a computed key is not statically replaceable by a bundler.
 */
export const RELEASE_ID_ENV_VAR = "RELEASE_ID";

/**
 * Namespaces the digest so the same release identifier can never produce the
 * same value for two different purposes, and so a future change of scheme is a
 * version bump here rather than a silent reuse.
 */
const RELEASE_NONCE_DOMAIN = "alpine-club-bookings:public-website-csp-nonce:v1";

export type PublicWebsiteNonceSource =
  /** `RELEASE_ID`, the intended production path. */
  | "release-id"
  /** `GIT_COMMIT_SHA`, already wired for the AID-3 knowledge bundle (#2372). */
  | "commit-sha"
  /** Neither was readable: one random value per process. See the docblock. */
  | "process-fallback";

export interface PublicWebsiteNonce {
  /** The `'nonce-…'` value used on every `(website)` response of this release. */
  nonce: string;
  source: PublicWebsiteNonceSource;
}

let resolution: Promise<PublicWebsiteNonce> | null = null;

/** The release identifier this image was built with, or null. */
function readReleaseId(): {
  releaseId: string;
  source: Exclude<PublicWebsiteNonceSource, "process-fallback">;
} | null {
  const releaseId = process.env.RELEASE_ID?.trim();
  if (releaseId) {
    return { releaseId, source: "release-id" };
  }

  // Already passed by CI and by scripts/run-production-blue-green-deploy.sh for
  // the knowledge bundle, so an image built before RELEASE_ID existed — or a
  // fork that only wired the older arg — still gets a per-release value rather
  // than the per-process fallback.
  const commitSha = process.env.GIT_COMMIT_SHA?.trim();
  if (commitSha) {
    return { releaseId: commitSha, source: "commit-sha" };
  }

  return null;
}

/**
 * `crypto.subtle` rather than `node:crypto`, because this module is imported by
 * `src/proxy.ts` as well as by a server component, and WebCrypto is the only
 * digest available on every middleware runtime. Async for the same reason —
 * both call sites are already async, so it costs nothing.
 */
async function digestToNonce(releaseId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${RELEASE_NONCE_DOMAIN}:${releaseId}`),
  );

  return Buffer.from(digest).toString("base64");
}

async function resolve(): Promise<PublicWebsiteNonce> {
  const release = readReleaseId();

  if (!release) {
    logger.error(
      { releaseIdEnvVar: RELEASE_ID_ENV_VAR },
      "No release identifier is readable, so public website pages will use a " +
        "per-process CSP nonce. A stored page generated by one process will not " +
        "hydrate if another process serves it — set RELEASE_ID at image build.",
    );
    return { nonce: createCspNonce(), source: "process-fallback" };
  }

  return {
    nonce: await digestToNonce(release.releaseId),
    source: release.source,
  };
}

/**
 * The fixed nonce and where it came from. Memoised on the resolved PROMISE, so
 * concurrent first callers share one digest rather than racing to compute it.
 */
export function resolvePublicWebsiteNonce(): Promise<PublicWebsiteNonce> {
  resolution ??= resolve();
  return resolution;
}

/** The fixed nonce for every `(website)` page of this release. */
export async function getPublicWebsiteNonce(): Promise<string> {
  return (await resolvePublicWebsiteNonce()).nonce;
}

// test seam
export function resetPublicWebsiteNonceCache(): void {
  resolution = null;
}
