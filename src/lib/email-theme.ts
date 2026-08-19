/**
 * Palette source for HTML email templates, and the render gate that guarantees
 * an email is coloured from the club's SAVED theme rather than the shipped
 * default.
 *
 * Emails derive their brand colours from the club (Site Style) theme so they
 * match the live site. The templates in `email-templates/` are synchronous and
 * are rendered from ~20 modules with no single render choke-point, so instead
 * of threading an async palette through every template we keep a module-level
 * cache: `emailPalette()` returns the cached palette immediately.
 *
 * ## The render gate (#2900)
 *
 * A synchronous accessor cannot wait for a database read, so a cold cache used
 * to serve the built-in default and start an UNAWAITED refresh. The first email
 * from a freshly started process or replica was therefore rendered in the
 * public default palette, and the next email a minute later in the club's saved
 * one — two messages from one workflow, two different brands (#2900).
 *
 * `renderEmailHtml()` closes that window centrally rather than per template:
 * every send site builds its HTML inside it, so the palette is loaded BEFORE
 * any themed HTML is constructed. `sendEmail()` awaits the same gate as a
 * backstop, which also covers the re-render an admin body override performs
 * inside `prepareEmailMessage`. Both are cheap once the palette is loaded — the
 * gate returns on an already-resolved state and does no I/O.
 *
 * ## What happens when the theme cannot be read
 *
 * `getWebsiteThemeRenderState()` never throws: on a database failure it returns
 * the DEFAULT theme values with `readFailed: true`. Committing that would cache
 * the public default AS IF it were the club's saved theme — silently, for a
 * whole TTL. So a read that reports `readFailed` is treated as a failure here:
 * nothing is committed, the last-good palette is kept, and the gate reports
 * `source: "built-in-default"` and logs a throttled warning naming the club
 * theme as unread. Mail is still sent — slightly-off branding beats a withheld
 * booking confirmation — but nothing in this module ever claims the default is
 * the club's choice. A club that has simply never customised its theme is NOT
 * this case: that read succeeds, `readFailed` is false, and the default values
 * genuinely are its theme.
 *
 * Repeated failures are bounded, not repeated per message: concurrent renders
 * share one in-flight read, a waiter gives up after `LOAD_TIMEOUT_MS`, and a
 * failed attempt suppresses further attempts for `FAILED_LOAD_COOLDOWN_MS`. A
 * database outage therefore costs at most one bounded wait per cooldown window
 * across the whole process, never one per email.
 *
 * ## Warm points and the write ordering
 *
 * Two explicit warm points call `primeEmailPalette()` (an unconditional, awaited
 * refresh): the server-boot instrumentation hook and the Site Style save API.
 * The boot prime means the first email after a cold start normally finds the
 * palette already loaded, and the save prime means an admin's colour change
 * reaches emails immediately rather than after the TTL lapses (#1912). A
 * monotonic write token orders every writer so an older background refresh
 * (mid-flight when the save primes) cannot resolve late and clobber the freshly
 * primed palette.
 *
 * The fallback is the SITE default theme (not the legacy hard-coded email
 * gold), so a process that cannot read the theme at all still renders emails
 * that look like the site. Colours are consumed as-is: Site Style seeds are
 * hex-only and the substrate generator only ever emits hex, so an email can
 * never carry an oklch() an email client cannot render. We do no contrast logic
 * (already enforced at theme-save, #1151).
 */

import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import {
  DEFAULT_CLUB_THEME_VALUES,
  deriveBrandShims,
  type ClubThemeValues,
} from "@/lib/club-theme-schema";
import logger from "@/lib/logger";

export interface EmailPalette {
  gold: string;
  charcoal: string;
  deep: string;
  mist: string;
  snow: string;
  ridge: string;
}

/**
 * Where the palette the next render will use actually came from.
 *
 * `club-theme` — read from the persisted Site Style theme (which may legitimately
 * be the shipped defaults, for a club that never customised them).
 *
 * `built-in-default` — the theme store could not be read. The render falls back
 * to the shipped default palette, and that is explicitly NOT a claim about what
 * the club saved.
 */
export type EmailPaletteSource = "club-theme" | "built-in-default";

export interface EmailPaletteReadiness {
  source: EmailPaletteSource;
}

const READY_FROM_STORE: EmailPaletteReadiness = { source: "club-theme" };
const READY_FROM_DEFAULT: EmailPaletteReadiness = {
  source: "built-in-default",
};

/**
 * Map normalised club-theme values -> the email palette roles (#2187 D7).
 *
 * Colours derive from the LIGHT-mode generated substrate via `deriveBrandShims`
 * (email is always light): `gold`/`deep` are the accent/neutral seeds, and
 * `charcoal`/`mist`/`snow`/`ridge` are the neutral-ramp light steps (12/3/1/8).
 * The generator only ever emits hex, so the palette is ALWAYS all-hex and emails
 * can never carry an oklch() an email client cannot render — no per-role hex
 * guard is needed now that the seed schema is hex-only (D6).
 */
function toEmailPalette(v: ClubThemeValues): EmailPalette {
  const s = deriveBrandShims(v);
  return {
    gold: s.gold,
    charcoal: s.charcoal,
    deep: s.deep,
    mist: s.mist,
    snow: s.snow,
    ridge: s.ridge,
  };
}

// Fallback = the SITE default theme (NOT the legacy hard-coded email gold), so
// emails still match the site even when the club theme cannot be read at all.
const DEFAULT_EMAIL_PALETTE: EmailPalette = toEmailPalette(
  DEFAULT_CLUB_THEME_VALUES
);

const TTL_MS = 5 * 60 * 1000;

/**
 * How long a render may wait for the FIRST authoritative theme read before it
 * gives up and renders with the built-in default. Email must not hang on a
 * theme read: a slow or wedged database would otherwise stall every booking
 * confirmation behind a cosmetic lookup. The read itself is not cancelled — if
 * it lands later it still commits, and the next email uses it.
 */
const LOAD_TIMEOUT_MS = 5_000;

/**
 * After a failed or timed-out authoritative read, do not attempt another for
 * this long. Without it a wedged database costs EVERY email a full
 * `LOAD_TIMEOUT_MS` wait; with it the whole process pays at most one such wait
 * per window.
 */
const FAILED_LOAD_COOLDOWN_MS = 30_000;

/** At most one "rendering with the built-in default" warning per window. */
const UNAVAILABLE_WARN_INTERVAL_MS = 5 * 60 * 1000;

let cached: EmailPalette = DEFAULT_EMAIL_PALETTE;
let cachedAt = 0;
let refreshing = false;
/**
 * True once a theme read has SUCCEEDED and committed. This is what the render
 * gate waits for, and it is deliberately not implied by `cachedAt`: a failed
 * read stamps nothing and must never be mistaken for a loaded palette.
 */
let loadedFromStore = false;
/** When the last authoritative attempt failed (0 = no failure on record). */
let failedLoadAt = 0;
/** Shared in-flight first load, so concurrent cold renders do ONE read. */
let inFlightLoad: Promise<void> | null = null;
let lastUnavailableWarnAt = 0;
// Monotonic token bumped at the START of every palette read (background refresh,
// explicit prime, or the render gate's first load). A read captures the token
// before its DB read and only commits its result if it still holds the latest
// token afterwards. This makes the last-STARTED read win: a slow read cannot
// overwrite a palette written by a read that started later. In particular, a
// stale in-flight background refresh (reading the OLD theme) can no longer
// clobber a save-time prime that started later and already wrote the NEW theme
// (#1912).
let latestWriteToken = 0;
// Test seam: `LOAD_TIMEOUT_MS` is deliberately long for production, and a suite
// asserting the timeout must not wait five real seconds for it.
let loadTimeoutMs = LOAD_TIMEOUT_MS;

/**
 * Read the persisted theme once and commit it if this read is still the latest
 * one to have started. Returns whether the palette now holds a value that came
 * from the store.
 *
 * Never throws. `getWebsiteThemeRenderState()` swallows its own database error
 * and hands back the DEFAULT values with `readFailed: true`, so `readFailed` —
 * not an exception — is the failure signal that must be honoured here.
 */
async function readAndCommitPalette(): Promise<boolean> {
  const token = ++latestWriteToken;
  try {
    const { values, readFailed } = await getWebsiteThemeRenderState();
    if (readFailed) {
      // The DEFAULT values this returned are a placeholder, not the club's
      // theme. Committing them would silently rebrand every email.
      return false;
    }
    // Only commit if no newer read (refresh, prime or gate) started while we
    // were reading; otherwise this result is stale and must not clobber it.
    if (token === latestWriteToken) {
      cached = toEmailPalette(values);
      cachedAt = Date.now();
      loadedFromStore = true;
      return true;
    }
    // A newer read superseded us. It will commit its own (at least as fresh)
    // result, so the palette is authoritative either way.
    return loadedFromStore;
  } catch {
    // Defensive: `getWebsiteThemeRenderState` is not expected to throw, but a
    // palette read must never take an email down with it.
    return false;
  }
}

/** One warning per window, so an outage cannot turn into a log flood. */
function warnRenderingWithBuiltInDefault(reason: string): void {
  const now = Date.now();
  if (
    lastUnavailableWarnAt !== 0 &&
    now - lastUnavailableWarnAt < UNAVAILABLE_WARN_INTERVAL_MS
  ) {
    return;
  }
  lastUnavailableWarnAt = now;
  logger.warn(
    { reason },
    "Rendering email with the built-in default palette: the club's saved Site Style theme could not be read. Email branding will not match the site until the theme becomes readable.",
  );
}

async function refreshEmailPalette(): Promise<void> {
  if (refreshing) {
    return;
  }
  refreshing = true;
  // Stamp the time up-front so a burst of renders triggers only one refresh.
  cachedAt = Date.now();
  try {
    await readAndCommitPalette();
  } finally {
    refreshing = false;
  }
}

/**
 * Synchronous palette accessor used by the email templates.
 *
 * It returns the cached palette and never waits, which is only correct because
 * `renderEmailHtml()` has already awaited `ensureEmailPaletteReady()` before any
 * template runs (#2900). It still self-warms in the background once the TTL
 * lapses, so a colour change made while the process is running reaches emails
 * without a restart.
 */
export function emailPalette(): EmailPalette {
  if (Date.now() - cachedAt > TTL_MS) {
    void refreshEmailPalette();
  }
  return cached;
}

/**
 * The render gate (#2900). Resolve the club palette BEFORE themed HTML is built.
 *
 * - Once the palette has been loaded from the store, this returns immediately
 *   and does no I/O; staleness is still handled by the TTL background refresh,
 *   so the caching behaviour after the first authoritative load is unchanged.
 * - On a cold cache it awaits a single shared read — concurrent renders join
 *   that one read rather than each starting their own.
 * - It waits at most `loadTimeoutMs`, and it never throws.
 * - When the store is unreadable it reports `built-in-default`, logs a throttled
 *   warning, and suppresses further attempts for `FAILED_LOAD_COOLDOWN_MS`.
 */
export async function ensureEmailPaletteReady(): Promise<EmailPaletteReadiness> {
  if (loadedFromStore) {
    if (Date.now() - cachedAt > TTL_MS) {
      void refreshEmailPalette();
    }
    return READY_FROM_STORE;
  }

  if (
    inFlightLoad === null &&
    failedLoadAt !== 0 &&
    Date.now() - failedLoadAt < FAILED_LOAD_COOLDOWN_MS
  ) {
    warnRenderingWithBuiltInDefault("recent-failure-cooldown");
    return READY_FROM_DEFAULT;
  }

  const load =
    inFlightLoad ??
    (inFlightLoad = (async () => {
      try {
        const ok = await readAndCommitPalette();
        failedLoadAt = ok ? 0 : Date.now();
      } finally {
        inFlightLoad = null;
      }
    })());

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    load,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, loadTimeoutMs);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  if (loadedFromStore) {
    return READY_FROM_STORE;
  }
  if (timedOut) {
    // Arm the cooldown from the WAITER too. The read is still in flight and may
    // yet succeed, but until it does, every further email would otherwise queue
    // behind its own full timeout.
    failedLoadAt = Date.now();
  }
  warnRenderingWithBuiltInDefault(timedOut ? "read-timeout" : "read-failed");
  return READY_FROM_DEFAULT;
}

/**
 * Build themed email HTML with the club palette guaranteed to be loaded first.
 *
 * This is the ONE place a send path is allowed to construct themed HTML, and
 * `email-render-gate-contract.test.ts` enforces that: every call to an
 * `email-templates/` render function in a sending module must sit inside this
 * helper's callback. That is what makes the guarantee central rather than a
 * per-template patch — a new template, or a new sender, inherits it without
 * anybody remembering to (#2900).
 *
 * Generic over the callback's return so a caller can build a subject/HTML pair,
 * or an array of per-recipient bodies, in one gated step.
 */
export async function renderEmailHtml<T>(build: () => T): Promise<T> {
  await ensureEmailPaletteReady();
  return build();
}

/**
 * HTML that was rendered in an EARLIER process and retained (today: the
 * `EmailLog` bodies the retry cron replays). It is not being constructed now, so
 * there is nothing for the render gate to colour — the colours are already baked
 * into the stored string. Named rather than inlined so the contract test can see
 * the deliberate, documented bypass instead of an unexplained raw string.
 */
export function retainedEmailHtml(html: string): string {
  return html;
}

/**
 * Await an unconditional refresh of the email palette from the persisted Site
 * Style theme. Unlike the TTL-gated background refresh `emailPalette()` uses,
 * this always reads the current theme and updates the cache, so an explicit warm
 * point sees the latest colours immediately:
 *   - server boot (instrumentation), so the palette is already loaded before the
 *     first email rather than making that email wait on the render gate;
 *   - a Site Style save (admin API), so a colour-scheme change reaches emails
 *     right away instead of only after the TTL lapses (#1912);
 *   - tests, so assertions see the loaded palette.
 *
 * Never throws — a read failure keeps the last-good/default palette and leaves
 * `loadedFromStore` alone, so the render gate still treats the palette as
 * unloaded and tries again rather than shipping the default as the club's theme.
 * It does not consult the `refreshing` guard, so a save-time prime cannot be
 * silently skipped by an in-flight background refresh. It also cannot be
 * silently CLOBBERED by one: via the shared `latestWriteToken`, an older
 * background refresh that resolves after this prime started will not overwrite
 * the palette this prime wrote, so a save/boot prime's colours stick until a
 * later read.
 */
export async function primeEmailPalette(): Promise<void> {
  const committed = await readAndCommitPalette();
  if (committed) {
    failedLoadAt = 0;
  }
}

/** Test hook: reset the module-level cache to its initial cold state. */
export function __resetEmailPaletteCacheForTests(options?: {
  loadTimeoutMs?: number;
}): void {
  cached = DEFAULT_EMAIL_PALETTE;
  cachedAt = 0;
  refreshing = false;
  latestWriteToken = 0;
  loadedFromStore = false;
  failedLoadAt = 0;
  inFlightLoad = null;
  lastUnavailableWarnAt = 0;
  loadTimeoutMs = options?.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
}
