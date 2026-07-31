"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Last-resort boundary: it catches only errors that escape the root layout, so
 * it is rarely the thing a visitor sees. `src/app/error.tsx` handles the ordinary
 * case (an error inside a page or a nested layout) and leaves the shell intact.
 *
 * This page CANNOT be forced to render per-request, unlike `not-found.tsx` and
 * `/display` (issue #2356). A global error boundary must be a Client Component
 * (Next's own `docs/01-app/03-api-reference/03-file-conventions/error.md`: "Error
 * boundaries must be Client Components", which is also why `metadata` /
 * `generateMetadata` are unsupported here), and route segment config is not read
 * from a client module. Adding `export const dynamic = "force-dynamic"` here was
 * tried and measured: the build accepts it with no error and no warning, and
 * `/_global-error` prerenders exactly as before — a silent no-op.
 *
 * Be careful what that prerendered artefact actually is, because it is easy to
 * get wrong. `.next/server/app/_global-error.html` — and the byte-identical
 * `server/pages/500.html` Next copies it to — is NEXT'S OWN built-in error shell
 * ("This page couldn't load / A server error occurred. Reload to try again"),
 * not a render of this component: none of the copy below appears in it. It is
 * emitted by the framework, ships six unnonced inline scripts, and nothing in
 * this file changes that. So the file sits on the allowlist in
 * `scripts/ci/check-prerendered-script-nonces.mjs` as a framework artefact we do
 * not control, and that carve-out will fall away only if a Next release starts
 * nonce-ing its own shell.
 *
 * What that leaves for this component: it renders dynamically, inside the
 * failing request, with the nonce — so it hydrates normally and `reset()` works.
 * The plain `<a href="/">` below is therefore not rescuing the static artefact
 * (it cannot: our markup is not in it). It is ordinary progressive enhancement —
 * a way out that survives a failed or blocked hydration, next to a button that
 * does not. Do not replace it with a `<Link>` or an `onClick` handler.
 *
 * The client-side Sentry capture below is a second channel, not the only one:
 * `onRequestError` in `src/instrumentation.ts` reports server-side render errors
 * from the server, and `base-server` logs them. (That hook was only reachable
 * from #2356 onward — before that it was exported from a module Next never reads
 * it from, so the server-side channel was dead.)
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
                action that still works if this page fails to hydrate, which is
                exactly the situation a crash page has to survive.
              */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- <Link> needs the router, which is unavailable if hydration fails; see above. */}
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
