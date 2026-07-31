import { NextResponse, type NextRequest } from "next/server";
import { clubConfig } from "@/config/club";
import { getClubIdentity } from "@/lib/club-identity-settings";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
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
 * Top-level path segments that belong to a route group OTHER than `(website)`,
 * and so are never gated.
 *
 * An ALLOW list would be wrong here: `(website)/[...slug]` is a catch-all that
 * claims every URL no other group claims, so "is this a public-website address?"
 * really is "is it anything but one of these?". Enumerated rather than inferred
 * because the proxy sees only a URL — it has no access to the route tree — and
 * `setup-gate.test.ts` walks `src/app/**` and fails if a new top-level route
 * outside `(website)` is added without being listed here.
 *
 * Everything here is either an operator surface or an address the operator needs
 * in order to FINISH setup: the admin area and its site-style wizard, the login
 * and password flows that get them there, the lodge/finance/authenticated member
 * areas, and the lobby display. `/api/*` is excluded by the proxy matcher itself
 * as well as here, which is what keeps `api/[[...unmatched]]/route.ts` (#2405)
 * answering JSON 404 — and the module gate's verb-by-verb parity with it —
 * identical in both setup states.
 *
 * @see setup-gate.test.ts — the filesystem check that keeps this exhaustive.
 */
// test seam
export const NON_WEBSITE_ROOT_SEGMENTS: ReadonlySet<string> = new Set([
  // (admin) — includes /admin/site-style, the wizard that ends the gate.
  "admin",
  // (authenticated)
  "book",
  "bookings",
  "calendar",
  "dashboard",
  "induction",
  "lodge-instructions",
  "nominations",
  "notices",
  "profile",
  // (public) — login and the token flows an operator may need mid-setup.
  "booking-requests",
  "change-password",
  "chores",
  "confirm-email-change",
  "family-invite",
  "forgot-password",
  "login",
  "membership-cancellation",
  "pay",
  "register",
  "reset-password",
  "school-bookings",
  "verify-email",
  // (finance)
  "finance",
  // (lodge)
  "lodge",
  // app root, outside every group
  "api",
  "display",
]);

/**
 * Machine-readable addresses served from the app root or `public/` that are not
 * the visitor-facing website. `robots.txt` in particular has to keep answering:
 * a crawler that cannot read it falls back to crawling everything, which is the
 * opposite of what the holding screen is for.
 */
const NON_WEBSITE_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/robots.txt",
  "/sitemap.xml",
  "/favicon.ico",
]);

function normalisePathname(pathname: string) {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/**
 * Does this URL resolve into the `(website)` route group — i.e. is it part of
 * the public website the holding screen stands in for?
 *
 * Case-sensitive, like Next's own routing: `/Admin/nope` is not the admin area,
 * it is an unmatched website address, and it should be gated exactly as
 * `/definitely-missing` is.
 */
// test seam
export function isPublicWebsitePath(pathname: string): boolean {
  const path = normalisePathname(pathname);

  if (!path.startsWith("/")) {
    return false;
  }

  if (path === "/") {
    return true;
  }

  if (NON_WEBSITE_EXACT_PATHS.has(path)) {
    return false;
  }

  const rootSegment = path.split("/")[1] ?? "";

  // `/_next/*` and any other framework-internal prefix. The proxy matcher
  // already drops `_next/static` and `_next/image`; this covers the rest.
  if (rootSegment.startsWith("_")) {
    return false;
  }

  return !NON_WEBSITE_ROOT_SEGMENTS.has(rootSegment);
}

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
