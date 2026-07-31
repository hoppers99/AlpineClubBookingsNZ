export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
    return;
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const instrumentation = await import("./instrumentation.node");
    await instrumentation.register();
  }
}

/**
 * Next's `onRequestError` contract, declared locally because `next` does not
 * export it from a public entry point (it lives at
 * `next/dist/server/instrumentation/types.d.ts`, a deep path we do not want to
 * import from). Kept structurally identical to that declaration; `request.path`
 * is the pathname plus query string, NOT a `url`.
 */
type InstrumentationOnRequestError = (
  error: unknown,
  request: Readonly<{
    path: string;
    method: string;
    headers: NodeJS.Dict<string | string[]>;
  }>,
  context: Readonly<{
    routerKind: string;
    routePath: string;
    routeType: string;
    renderSource?: string;
    revalidateReason?: string;
  }>
) => void | Promise<void>;

/**
 * OBS-02: report server-side render/route/action errors to Sentry.
 *
 * This MUST be exported from this module. Next reads the hook off the
 * `instrumentation` convention entry itself and nowhere else — `base-server`'s
 * `instrumentationOnRequestError` and
 * `next/dist/server/lib/router-utils/instrumentation-globals.external.js` both
 * call `instrumentation.onRequestError?.(…)` on the module they loaded from
 * `.next/server/instrumentation.js`. It is not discovered on a module that entry
 * lazily imports.
 *
 * It previously lived only in `./instrumentation.node`, which `register()` above
 * imports at runtime, so nothing ever reached it: the built entry chunk
 * contained no `onRequestError` at all and the server-side channel was dead
 * (found while reviewing #2356).
 *
 * Defined here rather than re-exported from `./instrumentation.node`, because a
 * static re-export would drag that module — Prisma, node-cron, `node:*`
 * builtins, every cron job — into the edge instrumentation bundle, which is
 * exactly what the runtime check in `register()` exists to avoid. The handler
 * needs nothing node-only, so it works on both runtimes as written.
 *
 * `notFound()` and `redirect()` do not arrive here: Next resolves those to a
 * well-known digest before the error handler runs
 * (`next/dist/server/app-render/create-error-handler.js` ->
 * `getDigestForWellKnownError` -> `isNextRouterError`), and
 * `sentry.server.config.ts` additionally lists `NEXT_NOT_FOUND` /
 * `NEXT_REDIRECT` in `ignoreErrors`. That matters now that
 * `src/app/not-found.tsx` renders per-request for every unmatched URL (#2356) —
 * bot probes do not become Sentry events.
 */
export const onRequestError: InstrumentationOnRequestError = async (
  error,
  request,
  context
) => {
  const Sentry = await import("@sentry/nextjs");

  Sentry.captureException(error, {
    tags: {
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
    },
    extra: {
      method: request.method,
      // `path`, not `url`: Next passes `{ path, method, headers }`. The previous
      // dead copy of this handler read `request.url`, which would have recorded
      // `undefined` on every event had it ever run. `beforeSend` in
      // `sentry.server.config.ts` redacts `extra` before anything leaves the
      // process, so the query string here is scrubbed like every other payload.
      path: request.path,
    },
  });
};
