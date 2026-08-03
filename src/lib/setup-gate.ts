import { NextResponse, type NextRequest } from "next/server";
import { clubConfig } from "@/config/club";
import { getClubIdentity } from "@/lib/club-identity-settings";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { isPublicWebsitePath } from "@/lib/public-website-paths";
import {
  buildSetupInProgressDocument,
  SETUP_IN_PROGRESS_RETRY_AFTER_SECONDS,
} from "@/lib/setup-in-progress-screen";

/**
 * "Not ready yet" for the whole public website until setup is complete (#2420).
 *
 * ## Why the decision lives in the proxy and not in a layout
 *
 * While `ClubTheme.completedAt IS NULL`, `(website)/layout.tsx` returns its
 * holding screen INSTEAD of `{children}`, so the page component never runs, its
 * `notFound()` never fires, and every address — real page and typo alike —
 * answers `200 OK`. A layout has no way to set a status code: `notFound()` is
 * the only status a render can raise and it means something else. So the
 * decision has to be made before the render starts, and the proxy is the only
 * place in this app that runs before every request and can write a status.
 *
 * ## The two choices this gate makes, stated rather than left to fall out
 *
 * - **A real, published page is 503 too, not 200.** While setup is incomplete
 *   the site is not open, so "this page exists" is not a distinction worth
 *   drawing for a visitor. Answering 200 for `/about` and 503 for `/nope` would
 *   also publish the club's page inventory to anyone probing a half-built
 *   install, and would let a crawler index pages before the club has chosen how
 *   they look. Every gated address gets the same screen and the same status.
 * - **`Retry-After` is sent.** Rationale and the value live with the constant in
 *   `setup-in-progress-screen.ts`.
 *
 * ## Interaction with #2352 (static / ISR rendering of website pages)
 *
 * This gate is deliberately NOT a render-time check, so making `(website)`
 * routes static or incrementally cached cannot bypass it: the proxy runs on the
 * request even when the response would have been served from a prerender. What
 * #2352 does need to handle is the reverse direction — a page prerendered while
 * setup was incomplete must be revalidated when setup completes, or the first
 * post-setup visitor gets a cache entry built under the holding screen.
 */

/**
 * The path classifier now lives in `src/lib/public-website-paths.ts` and is
 * RE-EXPORTED here, unchanged, so every existing importer and the filesystem
 * exhaustiveness check in `setup-gate.test.ts` keep working.
 *
 * It moved in the #2352 slice-1 review because other callers need it and must not
 * pay for this module's database reads. Since the D1 narrowing (owner decision,
 * 3 Aug 2026) those callers use a DIFFERENT predicate from the same module: the
 * nonce split and the CMS catch-all's territory are `isFixedNonceWebsitePath()`
 * and `isCmsServablePageSlug()`, which cover only the five approved routes, while
 * `isPublicWebsitePath()` — the one this gate asks — deliberately still claims the
 * whole public website, both route groups. That is what keeps the pre-setup 503
 * holding screen in front of `/hut-leader-instructions`, `/join/[code]` and
 * `/join/verify/[token]` after they moved out of the fixed-nonce group. The
 * module's header sets out all three questions and which predicate answers each.
 */
export {
  isPublicWebsitePath,
  NON_WEBSITE_ROOT_SEGMENTS,
} from "@/lib/public-website-paths";

type SetupGateState =
  | { isComplete: true }
  | { isComplete: false; document: string };

/**
 * How long the resolved setup state (and, while incomplete, the rendered
 * holding-screen document) is reused for.
 *
 * The point of caching is the constraint that this gate must not add a database
 * read to every request that `(website)/layout.tsx` is about to make anyway. The
 * layout reads `ClubTheme` through a 15-second tagged cache
 * (`getCachedWebsiteThemeRenderState`); matching that TTL here means the gate
 * costs at most one extra single-row read per 15 seconds per process, not one
 * per request. Once setup IS complete the cached answer is a bare boolean and
 * nothing else is read at all.
 *
 * The proxy is bundled separately from the app's route handlers, so the
 * `revalidateTag` the site-style save already issues cannot reach this memo —
 * the TTL is the propagation bound. An operator who finishes setup sees the site
 * open within 15 seconds.
 */
export const SETUP_STATE_TTL_MS = 15_000;

let cachedState: { expiresAt: number; state: SetupGateState } | null = null;
let inFlight: Promise<SetupGateState> | null = null;

/**
 * Last-resort holding screen, for the case where even resolving the setup state
 * throws — a Prisma client that failed to construct at all, say, which is a
 * realistic first-boot state for the very install this screen exists to cover.
 * Config-derived only, so it needs nothing but the club file. Answering 503 with
 * a readable screen beats the 500 an unhandled throw in the proxy would produce.
 */
function fallbackSetupGateState(): SetupGateState {
  return {
    isComplete: false,
    document: buildSetupInProgressDocument({
      clubName: clubConfig.name,
      contactEmail: clubConfig.contactEmail ?? clubConfig.supportEmail,
      themeCss: "",
    }),
  };
}

async function loadSetupGateState(): Promise<SetupGateState> {
  const theme = await getWebsiteThemeRenderState();

  if (theme.isComplete) {
    return { isComplete: true };
  }

  // Only read once the site is known to be unconfigured, and read from exactly
  // the sources `(website)/layout.tsx`'s own pre-setup branch reads, so the two
  // screens can never name the club or the contact address differently. Neither
  // call throws — both fall back to config defaults if the database is
  // unreachable — which matters because this path has to be able to render a
  // 503 body during precisely the outage that produced it.
  const [identity, emailSettings] = await Promise.all([
    getClubIdentity(),
    loadEmailMessageSettings(),
  ]);

  return {
    isComplete: false,
    document: buildSetupInProgressDocument({
      clubName: identity.name,
      contactEmail: emailSettings.contactEmail,
      themeCss: theme.css,
    }),
  };
}

/**
 * The current setup state, memoised for {@link SETUP_STATE_TTL_MS}.
 *
 * Single-flight: concurrent requests arriving on a cold or expired memo share
 * one read rather than each opening their own.
 *
 * Fails CLOSED. `getWebsiteThemeRenderState()` already reports `isComplete:
 * false` when the `ClubTheme` read fails, so a database outage is answered with
 * the holding screen — which is both what the layout does today and what 503
 * literally means. An unexpected throw further down falls back to the
 * config-derived screen rather than propagating a 500. Failing open in either
 * case would put the site back to answering 200 for every address, which is the
 * defect this gate exists to fix.
 */
export async function getSetupGateState(): Promise<SetupGateState> {
  const now = Date.now();

  if (cachedState && cachedState.expiresAt > now) {
    return cachedState.state;
  }

  inFlight ??= loadSetupGateState()
    .catch(() => fallbackSetupGateState())
    .then((state) => {
      cachedState = { expiresAt: Date.now() + SETUP_STATE_TTL_MS, state };
      return state;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

// test seam
export function resetSetupGateCache() {
  cachedState = null;
  inFlight = null;
}

/**
 * The 503 holding-screen response for a gated request, or `null` to let the
 * request continue.
 *
 * `no-store` is not optional: the holding screen must not outlive setup in a
 * browser or shared cache, and `/` is otherwise allow-listed as cacheable for
 * 60 seconds by `getAnonymousPageCacheControl`.
 */
export async function getSetupInProgressResponse(
  request: NextRequest,
): Promise<NextResponse | null> {
  if (!isPublicWebsitePath(request.nextUrl.pathname)) {
    return null;
  }

  const state = await getSetupGateState();

  if (state.isComplete) {
    return null;
  }

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": String(SETUP_IN_PROGRESS_RETRY_AFTER_SECONDS),
  });

  // Every method, not just GET: a form POST to a website address during setup is
  // no more serviceable than a GET of it. HEAD carries the same status with no
  // body, per HTTP.
  return new NextResponse(request.method === "HEAD" ? null : state.document, {
    status: 503,
    headers,
  });
}
