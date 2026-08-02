import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { ASSET_NOT_FOUND_REWRITES } from "./src/lib/asset-url-404";

const nextConfig: NextConfig = {
  images: {
    deviceSizes: [640, 750, 828, 1080, 1200, 1536, 1920, 2048, 3840],
  },
  output: "standalone",
  poweredByHeader: false,
  /**
   * The full-route (ISR) cache lives in memory, not on disk (#2352 slice 1).
   *
   * Read against the vendored next@16.2.12 rather than assumed, because the
   * default would not have worked here at all:
   * `FileSystemCache.getFilePath()` puts an `APP_PAGE` entry under
   * `<distDir>/server/app/…` — the SAME directory as the compiled route modules,
   * not under `.next/cache`. The production container runs with
   * `read_only: true` and a tmpfs on `/app/.next/cache` only
   * (`docker-compose.yml`), so every store would have failed with `EROFS`. It
   * would not have crashed — `IncrementalCache.set()` wraps the handler in a
   * try/catch and only warns — but it would have logged a warning on every page
   * generation while quietly caching in memory anyway, because
   * `FileSystemCache.set()` writes to its memory LRU BEFORE it consults
   * `flushToDisk`. Turning the disk half off makes the real behaviour the
   * configured one. Mounting a tmpfs over `server/app` was the alternative and is
   * not available: it would hide the compiled route modules that ship there.
   *
   * The memory store is better suited to this design in two ways beyond that:
   *  • it is bounded by an LRU rather than by free space, so the enumeration risk
   *    the planning pass raised — a crawler walking nonsense catch-all paths,
   *    each one storing a 404 entry — evicts instead of filling something up;
   *  • it is per-process and dies with the process, which is the property the
   *    per-release CSP nonce already relies on (`src/lib/release-nonce.ts`).
   *
   * `revalidatePath()`/`revalidateTag()` still clear it: the tag-expiry check in
   * `FileSystemCache.get()` runs on the entry whichever store it came from.
   */
  experimental: {
    isrFlushToDisk: false,
  },
  /**
   * The ceiling on the in-memory cache the line above makes authoritative,
   * stated here rather than inherited from Next's 50MB default so the number is
   * reviewable next to the container's `mem_limit: 1g`. Shared with the fetch
   * cache, which is what it was sized for before this; a stored CMS page is tens
   * of kilobytes of HTML plus its RSC payload, so 64MB holds a club's whole site
   * many times over and still leaves the LRU room to evict a crawler's noise.
   */
  cacheMaxMemorySize: 64 * 1024 * 1024,
  turbopack: {
    root: process.cwd(),
  },
  /**
   * Trace the deployed-code knowledge bundle (AID-3, #2372) into
   * `.next/standalone` so it ships inside the running artifact. The bundle is
   * generated in the Docker builder by `npm run diagnostics:bundle` (before
   * `next build`), written to this path, and read at runtime by
   * `src/lib/diagnostics/knowledge/load.ts`. Path literal kept in lockstep with
   * `KNOWLEDGE_BUNDLE_RELATIVE_PATH`; not imported because Next's config loader
   * does not apply the tsconfig path mapping (see the rewrites note below). The
   * Dockerfile also copies `.artifacts/` into the runner as a guaranteed
   * placement; this trace is the framework-native mechanism the diagnostics
   * route (#2378) will key to directly.
   */
  outputFileTracingIncludes: {
    "/**": [".artifacts/diagnostics/knowledge-bundle.json"],
  },
  /**
   * Static-asset URLs nothing serves are answered without a document (#2404).
   * The rules, why NEITHER of them may match an `/api` URL (#2405's module-state
   * parity holds on the response headers only while no rewrite runs on `/api` at
   * all), and why `_next/image` is absent are all documented in
   * `src/lib/asset-url-404.ts`.
   *
   * `afterFiles` is the only stage that works here: Next checks `public/`,
   * `_next/static` and the non-dynamic routes BEFORE it consults these rules, so
   * a real asset is served exactly as before and never reaches them, while a
   * miss is terminated before the dynamic `(website)/[...slug]` catch-all can
   * turn it into a page render. `beforeFiles` would shadow every real asset;
   * `fallback` runs after the catch-all has already claimed the URL.
   *
   * Relative import, not the `@/` alias: this file is loaded by Next's own
   * config loader, which does not apply the tsconfig path mapping.
   */
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [...ASSET_NOT_FOUND_REWRITES],
      fallback: [],
    };
  },
};

// Warn at build time if Sentry is partially configured
if (process.env.SENTRY_DSN && !process.env.SENTRY_AUTH_TOKEN) {
  console.warn(
    "\x1b[33m⚠ SENTRY_DSN is set but SENTRY_AUTH_TOKEN is missing — source maps will not be uploaded. Production stack traces will be unreadable.\x1b[0m"
  );
}

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG || "",
  project: process.env.SENTRY_PROJECT || "",
});
