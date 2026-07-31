import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

/**
 * Guards the wiring of Next's server-side error hook (#2356 review).
 *
 * The regression this exists to catch is silent by construction: Next reads
 * `onRequestError` off the `instrumentation` convention module and nowhere else,
 * so exporting it from any other file (as `src/instrumentation.node.ts` did for
 * a long time) leaves the hook unreachable with no error, no warning, and a
 * clean build. Nothing observes the loss except the absence of Sentry events
 * that were never going to arrive.
 */
describe("instrumentation convention module", () => {
  beforeEach(() => {
    captureException.mockClear();
  });

  it("exports onRequestError, which is the only place Next looks for it", async () => {
    // Deliberately imports the CONVENTION module, not `./instrumentation.node`:
    // the property under test is where the export lives, not that it exists
    // somewhere in the tree.
    const instrumentation = await import("@/instrumentation");
    expect(typeof instrumentation.onRequestError).toBe("function");
  });

  it("reports the error to Sentry with the route context Next supplies", async () => {
    const { onRequestError } = await import("@/instrumentation");
    const error = new Error("boom");

    await onRequestError(
      error,
      { path: "/bookings/42?token=secret", method: "GET", headers: {} },
      {
        routerKind: "App Router",
        routePath: "/bookings/[id]",
        routeType: "render",
        renderSource: "server-rendering",
        revalidateReason: undefined,
      }
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    const [captured, options] = captureException.mock.calls[0] as [
      unknown,
      { tags: Record<string, unknown>; extra: Record<string, unknown> },
    ];
    expect(captured).toBe(error);
    expect(options.tags).toEqual({
      routerKind: "App Router",
      routePath: "/bookings/[id]",
      routeType: "render",
      renderSource: "server-rendering",
    });
    // `path`, not `url`: Next passes `{ path, method, headers }`, so the old
    // `request.url` read would have recorded `undefined` on every event.
    expect(options.extra).toEqual({
      method: "GET",
      path: "/bookings/42?token=secret",
    });
  });
});
