"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * This page CANNOT be forced to render per-request, unlike `not-found.tsx` and
 * `/display` (issue #2356). A global error boundary must be a Client Component
 * (Next's own `docs/01-app/03-api-reference/03-file-conventions/error.md`: "Error
 * boundaries must be Client Components", which is also why `metadata` /
 * `generateMetadata` are unsupported here), and route segment config is not read
 * from a client module. Adding `export const dynamic = "force-dynamic"` here was
 * tried and measured: the build accepts it with no error and no warning, and
 * `/_global-error` prerenders exactly as before — a silent no-op.
 *
 * The consequence, accepted and bounded: Next copies the prerendered
 * `_global-error.html` to `server/pages/500.html` and registers it in
 * `pages-manifest.json`, and `base-server` serves that copy for a 500 that
 * escapes the app render (a proxy/middleware failure, a route-resolution
 * failure). Its six inline bootstrap scripts carry no nonce, so under our
 * nonce-only CSP that copy never hydrates: the Sentry `useEffect` below does not
 * fire and `reset()` cannot run.
 *
 * Two things bound the damage. The common case is unaffected — an error thrown
 * INSIDE an app render renders this component dynamically in the failing
 * request, with the nonce, so it hydrates and behaves normally. And the server
 * has already reported the error by then (`onRequestError` in
 * `src/instrumentation.node.ts` captures it to Sentry, and `base-server` logs
 * it), so the client capture below is a duplicate channel, not the only one.
 *
 * What was NOT acceptable was the crash page offering only a button that does
 * nothing when it cannot hydrate, so the plain `<a>` below is deliberate: it
 * needs no JavaScript and is always a working way out. Do not replace it with a
 * `<Link>` or an `onClick` handler.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // OBS-02: Report to Sentry with error digest for correlation
    Sentry.captureException(error, {
      tags: { digest: error.digest },
    });
    console.error("Global error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "system-ui, sans-serif",
            backgroundColor: "#f9fafb",
          }}
        >
          <div style={{ textAlign: "center", maxWidth: "28rem", padding: "1rem" }}>
            <h1
              style={{
                fontSize: "3.75rem",
                fontWeight: "bold",
                color: "#111827",
                marginBottom: "1rem",
              }}
            >
              500
            </h1>
            <h2
              style={{
                fontSize: "1.5rem",
                fontWeight: "600",
                color: "#374151",
                marginBottom: "1rem",
              }}
            >
              Something went wrong
            </h2>
            <p style={{ color: "#6b7280", marginBottom: "2rem" }}>
              A critical error occurred. Please try refreshing the page.
            </p>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.75rem",
                justifyContent: "center",
              }}
            >
              <button
                onClick={reset}
                style={{
                  padding: "0.75rem 1.5rem",
                  backgroundColor: "#111827",
                  color: "white",
                  border: "none",
                  borderRadius: "0.5rem",
                  cursor: "pointer",
                  fontSize: "1rem",
                }}
              >
                Try Again
              </button>
              {/*
                Plain anchor, never a <Link> or an onClick: this is the only
                action that still works on the statically served copy of this
                page, whose scripts our own CSP blocks (see the note above).
              */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- <Link> needs the router, which cannot hydrate here; see above. */}
              <a
                href="/"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "0.75rem 1.5rem",
                  border: "1px solid #d1d5db",
                  color: "#374151",
                  borderRadius: "0.5rem",
                  fontSize: "1rem",
                  textDecoration: "none",
                }}
              >
                Go to Home Page
              </a>
            </div>
            {error.digest && (
              <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#9ca3af" }}>
                Error ID: {error.digest}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
