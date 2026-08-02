/**
 * Shared helper for tests that pin `process.env.TZ` (#2485).
 *
 * ## The hazard
 *
 * In Node, `delete process.env.TZ` does **not** return the process to the
 * system's default zone. Node/V8 only re-derives the resolved zone when
 * `process.env.TZ` is ASSIGNED; deleting the variable removes it from the
 * environment but leaves the last-assigned zone cached. Verified empirically
 * (#2485): set `TZ=Pacific/Honolulu`, delete the variable, and every later
 * `Date`/`Intl` call in the same worker still resolves Honolulu.
 *
 * Test files share a worker process (Vitest's isolation resets the module
 * registry per file, not `process.env`), so a suite that pins a zone and then
 * merely deletes it on the way out leaks that zone into whichever suite the
 * runner happens to schedule next — an order-dependent flake with nothing in
 * any diff to blame.
 *
 * ## The fix
 *
 * Never restore by deleting alone. Resolve the REAL starting zone —
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` — before the first
 * assignment, and on the way out:
 *
 * - if `process.env.TZ` started **defined**, assign it back to that exact
 *   value (an assignment always invalidates the cache correctly);
 * - if it started **undefined**, ASSIGN the resolved host zone first (so the
 *   cache is correct), then delete the variable (removing it is safe once the
 *   cache already agrees with the host default).
 *
 * ## Usage
 *
 * Capture once, at module top level or at the top of a `describe` block —
 * before anything in the file has assigned `process.env.TZ` — and restore
 * from an `afterEach/afterAll` or a `finally`:
 *
 * ```ts
 * const hostTimeZone = captureHostTimeZone();
 *
 * afterEach(() => {
 *   hostTimeZone.restore();
 * });
 * ```
 *
 * For a single pinned call, `withTimeZone`/`withTimeZoneAsync` wrap the
 * capture-set-run-restore sequence:
 *
 * ```ts
 * withTimeZone("Pacific/Auckland", () => {
 *   expect(formatSomething(date)).toBe("...");
 * });
 * ```
 */

export interface HostTimeZone {
  /**
   * Restore `process.env.TZ` to exactly what it was when captured, forcing
   * Node to re-cache the correct zone rather than merely deleting the
   * variable.
   */
  restore(): void;
}

/**
 * Capture the process's current `TZ` environment value and its actually
 * resolved zone. Call this BEFORE anything assigns `process.env.TZ`.
 */
export function captureHostTimeZone(): HostTimeZone {
  const originalEnvTz = process.env.TZ;
  const originalHostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    restore(): void {
      if (originalEnvTz === undefined) {
        // An assignment is what invalidates Node's cached zone; deleting
        // alone does not. Assign the resolved host zone first so the cache is
        // correct, then remove the variable to match the original environment.
        process.env.TZ = originalHostZone;
        delete process.env.TZ;
      } else {
        process.env.TZ = originalEnvTz;
      }
    },
  };
}

/** Run `run()` with `process.env.TZ` pinned to `timeZone`, then restore. */
export function withTimeZone<T>(timeZone: string, run: () => T): T {
  const hostTimeZone = captureHostTimeZone();
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    hostTimeZone.restore();
  }
}

/**
 * `withTimeZone` for an async `run` — the restore only fires after the
 * returned promise settles, so it is safe to await work (fetches, route
 * handlers) inside `run` without the zone snapping back mid-flight.
 */
export async function withTimeZoneAsync<T>(
  timeZone: string,
  run: () => Promise<T>,
): Promise<T> {
  const hostTimeZone = captureHostTimeZone();
  process.env.TZ = timeZone;
  try {
    return await run();
  } finally {
    hostTimeZone.restore();
  }
}
