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
 * failed OR TIMED-OUT attempt makes every render inside the next
 * `FAILED_LOAD_COOLDOWN_MS` proceed immediately on the current palette instead of
 * waiting again. A database outage therefore costs at most one bounded wait per
 * cooldown window across the whole process, never one per email — including when
 * the read is WEDGED rather than failing, which is the case that matters most,
 * because a read that timed out is by definition still in flight.
 *
 * "Proceed immediately" rather than "attempt nothing": the in-flight read is
 * never cancelled, and if it lands late it still commits and lifts the cooldown,
 * so the first email after the theme becomes readable is correctly branded.
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
 * After a failed or timed-out authoritative read, do not WAIT for another for
 * this long: renders inside the window take the current palette immediately.
 * Without it a wedged database costs EVERY email a full `LOAD_TIMEOUT_MS` wait;
 * with it the whole process pays at most one such wait per window.
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
// Monotonic token issued at the START of every palette read (background refresh,
// explicit prime, or the render gate's first load), paired with the token of the
// read that last COMMITTED. A read commits only if its own token is higher than
// the last committed one, which makes the last-STARTED read win: a slow read
// cannot overwrite a palette written by a read that started later. In
// particular, a stale in-flight background refresh (reading the OLD theme) can
// no longer clobber a save-time prime that started later and already wrote the
// NEW theme (#1912).
//
// Comparing against the last COMMITTED token, rather than against the newest
// token merely ISSUED, is deliberate. A read that is overtaken by one still in
// flight has valid values and nothing newer has landed yet, so discarding it
// would leave the palette unloaded and make the gate report a read failure it
// did not have — an email in the default brand, plus a "theme unreadable"
// warning operators are told to treat as a database fault, from a read that
// succeeded. The newer read still wins when it lands, because its token is
// higher again.
let latestWriteToken = 0;
let latestCommittedToken = 0;
// Test seam: `LOAD_TIMEOUT_MS` is deliberately long for production, and a suite
// asserting the timeout must not wait five real seconds for it.
let loadTimeoutMs = LOAD_TIMEOUT_MS;

/**
 * What one authoritative theme read did.
 *
 * `committed` — read succeeded and its values are now the palette.
 * `superseded` — read succeeded, but a read that started LATER had already
 *   committed, so its (at least as fresh) values stand instead. The palette is
 *   authoritative either way, so this is a success, not a failure.
 * `failed` — the theme could not be read. Nothing was committed and the palette
 *   is whatever it was before.
 */
type PaletteReadOutcome = "committed" | "superseded" | "failed";

/**
 * Read the persisted theme once and commit it unless a read that started later
 * has already committed.
 *
 * Never throws. `getWebsiteThemeRenderState()` swallows its own database error
 * and hands back the DEFAULT values with `readFailed: true`, so `readFailed` —
 * not an exception — is the failure signal that must be honoured here.
 *
 * The invariant every caller relies on: an outcome other than `failed` implies
 * `loadedFromStore` is true. Either this read committed, or a newer one already
 * had.
 */
async function readAndCommitPalette(): Promise<PaletteReadOutcome> {
  const token = ++latestWriteToken;
  try {
    const { values, readFailed } = await getWebsiteThemeRenderState();
    if (readFailed) {
      // The DEFAULT values this returned are a placeholder, not the club's
      // theme. Committing them would silently rebrand every email.
      return "failed";
    }
    if (token > latestCommittedToken) {
      cached = toEmailPalette(values);
      cachedAt = Date.now();
      loadedFromStore = true;
      latestCommittedToken = token;
      return "committed";
    }
    // A read that started later already committed. Its result is at least as
    // fresh as ours, so the palette is authoritative and this read succeeded.
    return "superseded";
  } catch {
    // Defensive: `getWebsiteThemeRenderState` is not expected to throw, but a
    // palette read must never take an email down with it.
    return "failed";
  }
}

/**
 * One warning per window, so an outage cannot turn into a log flood.
 *
 * The logger call is guarded because `ensureEmailPaletteReady()` is documented as
 * never throwing and is now awaited on EVERY send path. A logger fault on this
 * branch — a transport failure, or in a test a mock without a `warn` member —
 * would otherwise turn cosmetically-off branding into a lost email: `sendEmail()`
 * awaits the gate as its first statement, so the throw lands before any
 * `EmailLog` row exists, and a per-recipient `catch` (as in `notices-email.ts`)
 * swallows it, leaving nothing for the retry cron to find. The throttle stamp is
 * taken BEFORE the call so a throwing logger cannot defeat it either.
 */
function warnRenderingWithBuiltInDefault(reason: string): void {
  const now = Date.now();
  if (
    lastUnavailableWarnAt !== 0 &&
    now - lastUnavailableWarnAt < UNAVAILABLE_WARN_INTERVAL_MS
  ) {
    return;
  }
  lastUnavailableWarnAt = now;
  try {
    logger.warn(
      { reason },
      "Rendering email with the built-in default palette: the club's saved Site Style theme could not be read. Email branding will not match the site until the theme becomes readable.",
    );
  } catch {
    // Nothing useful is left to do: the fallback for a broken logger cannot be
    // the logger. The email still goes out, which is the point.
  }
}

async function refreshEmailPalette(): Promise<void> {
  if (refreshing) {
    return;
  }
  // The failure cooldown is the ONE place that decides not to hammer an
  // unreadable store, so the TTL refresh honours it too. Without this a process
  // whose gate load failed would still start a background read from the very
  // next `emailPalette()` call, which is exactly the traffic the cooldown
  // exists to stop.
  if (
    failedLoadAt !== 0 &&
    Date.now() - failedLoadAt < FAILED_LOAD_COOLDOWN_MS
  ) {
    return;
  }
  refreshing = true;
  // Stamp the time up-front so a burst of renders triggers only one refresh.
  const cachedAtBeforeRefresh = cachedAt;
  cachedAt = Date.now();
  try {
    const outcome = await readAndCommitPalette();
    if (outcome === "failed") {
      // Nothing was committed, so the TTL clock must not stay advanced: leaving
      // it would suppress the next attempt for a full TTL, and an admin who
      // changed the club's colours during a brief database blip would wait five
      // minutes for emails to pick them up rather than the thirty seconds the
      // failure cooldown advertises. Rolling it back is only safe BECAUSE the
      // cooldown is armed in the same breath — otherwise the very next
      // `emailPalette()` call would start another read, which is the traffic the
      // cooldown exists to stop.
      cachedAt = cachedAtBeforeRefresh;
      failedLoadAt = Date.now();
    } else {
      failedLoadAt = 0;
    }
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
 *   warning, and suppresses further WAITING for `FAILED_LOAD_COOLDOWN_MS`.
 */
export async function ensureEmailPaletteReady(): Promise<EmailPaletteReadiness> {
  if (loadedFromStore) {
    if (Date.now() - cachedAt > TTL_MS) {
      void refreshEmailPalette();
    }
    return READY_FROM_STORE;
  }

  // Inside the cooldown window, render now on the current palette. This check
  // deliberately does NOT care whether a read is still in flight, and that is
  // the whole point of the bound: a read that TIMED OUT is by definition still
  // pending, so requiring `inFlightLoad === null` here would skip the cooldown
  // in exactly the case it exists for. A wedged theme read — a `ClubTheme`
  // SELECT parked behind an ACCESS EXCLUSIVE lock during a migration, say, with
  // no statement timeout to end it — would then charge EVERY email a fresh full
  // `loadTimeoutMs`: two gate calls per message, three with a stored body
  // override, so 10-15s each, and `notices-email.ts` loops recipients
  // sequentially with the gate inside the loop, which on a 300-member notice is
  // most of an hour. Two admin refund-request replies also await the gate on the
  // request path, where that wait is the HTTP response time.
  //
  // A late-settling read still wins: it commits, clears `failedLoadAt` and sets
  // `loadedFromStore`, so the next email takes the warm early return above and
  // the cooldown is over the moment the theme is actually readable.
  if (
    failedLoadAt !== 0 &&
    Date.now() - failedLoadAt < FAILED_LOAD_COOLDOWN_MS
  ) {
    warnRenderingWithBuiltInDefault("recent-failure-cooldown");
    return READY_FROM_DEFAULT;
  }

  const load =
    inFlightLoad ??
    (inFlightLoad = (async () => {
      let outcome: PaletteReadOutcome = "failed";
      try {
        outcome = await readAndCommitPalette();
      } catch {
        // `readAndCommitPalette` already swallows everything; belt and braces so
        // this shared promise can never reject and take a waiter's send with it.
        outcome = "failed";
      } finally {
        inFlightLoad = null;
      }
      failedLoadAt = outcome === "failed" ? Date.now() : 0;
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
    // behind its own full timeout. Note the `loadedFromStore` check above runs
    // FIRST, so a read that committed in the same tick as the timer firing is
    // not recorded as a failure.
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
  const outcome = await readAndCommitPalette();
  if (outcome !== "failed") {
    failedLoadAt = 0;
  }
  // A FAILED prime deliberately does not arm the cooldown. A boot or save prime
  // runs ahead of any email, so spending the next thirty seconds of email
  // branding on a wait no email asked for would work against #2900; the gate
  // arms the cooldown when a read fails in service of an actual send.
}

/** Test hook: reset the module-level cache to its initial cold state. */
export function __resetEmailPaletteCacheForTests(options?: {
  loadTimeoutMs?: number;
}): void {
  cached = DEFAULT_EMAIL_PALETTE;
  cachedAt = 0;
  refreshing = false;
  latestWriteToken = 0;
  latestCommittedToken = 0;
  loadedFromStore = false;
  failedLoadAt = 0;
  inFlightLoad = null;
  lastUnavailableWarnAt = 0;
  loadTimeoutMs = options?.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
}
