"use client";

import Link from "next/link";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  resolveAnalyticsDecision,
  type ConsentChoice,
  type ConsentSource,
  type StoredConsent,
} from "@/lib/analytics-consent-decision";
import {
  ANALYTICS_CONSENT_STORAGE_KEY,
  readStoredConsent,
  writeStoredConsent,
} from "@/lib/analytics-consent-storage";
import {
  buildAnalyticsPageLocation,
  isAnalyticsEligiblePath,
  sanitiseAnalyticsReferrer,
} from "@/lib/analytics-route-policy";
import {
  ANALYTICS_PREFERENCES_ATTRIBUTE,
  ANALYTICS_PREFERENCES_AVAILABILITY_EVENT,
  ANALYTICS_PREFERENCES_OPEN_EVENT,
} from "@/lib/analytics-preferences-channel";
import type { AnalyticsRuntimeConfig } from "@/lib/analytics-settings-shared";

/**
 * The public Google Analytics runtime: the consent banner, the tag, the visitor
 * preferences panel, and the route/URL policy that bounds all three (#2573).
 *
 * ## What can be sent to Google, and when
 *
 * Nothing at all unless `config` is non-null — which the server makes so only when
 * the analytics module is ON and the club has saved a VALID GA4 measurement ID
 * (`resolveAnalyticsRuntimeConfig`, fail-closed on every other state including a
 * database read failure). Then:
 *
 *  • **Banner enabled (recommended, the default).** No script, no request, no
 *    cookieless ping and no consent-status signal reaches Google before the visitor
 *    selects Accept. That is enforced structurally rather than by a flag: while
 *    `analyticsAllowed` is false this component renders NO `<Script>` at all, and
 *    every `gtag()` call it makes is a push onto a local `window.dataLayer` array
 *    that nothing transmits until `gtag/js` itself is fetched. Decline, and closing
 *    or dismissing the banner, are the same thing and leave the tag unloaded.
 *  • **Banner disabled.** The tag loads automatically on eligible pages, a decline
 *    recorded while the banner was showing is ignored once (owner section 4), and a
 *    later opt-out through the preferences panel is still honoured (owner
 *    clarification 1). Advertising storage, advertising user data and advertising
 *    personalisation stay DENIED in both modes; Google's advanced consent mode is
 *    deliberately not implemented.
 *
 * Once loaded, the only URL information sent is `origin + pathname` for an
 * analytics-eligible route — never a query string, never a fragment, never a token,
 * PIN, email address, member id, booking id or payment id. `send_page_view: false`
 * turns Google's own automatic page view OFF so the raw `location.href` is never
 * used, and this component sends one sanitised `page_view` per navigation instead,
 * de-duplicated against the last value actually sent. The referrer is sanitised too:
 * gtag would otherwise hand Google `document.referrer` verbatim, which for a visitor
 * arriving from `/pay/<token>` is the payment token.
 *
 * ## Leaving the public website
 *
 * This component is mounted by the two public WEBSITE layouts and by nothing else,
 * so a soft navigation into the member area, the admin area or the login/recovery
 * group unmounts it. Unmounting a `<Script>` cannot unload an executed library, so
 * the unmount effect below sets Google's per-ID kill switch and queues a denial —
 * without it the tag would stay resident and keep collecting on precisely the routes
 * owner section 7 excludes. The visitor's own opt-out is propagated the same way
 * across other open tabs, over the `storage` event.
 *
 * ## No inline script, deliberately
 *
 * Before #2573 this component injected two INLINE scripts (the consent bootstrap and
 * the `gtag('config', …)` call) and had to stamp them with the loaded document's CSP
 * nonce. Both are gone: every `gtag` call now happens in this bundle, pushing onto
 * `window.dataLayer` exactly as the inline snippets did, in the same order, and
 * `gtag/js` replays the queue when it loads. One external `<Script src>` is left, and
 * it still needs the nonce — `script-src` carries no `'strict-dynamic'`, so a
 * dynamically injected script tag is nonce-checked whether it is inline or not.
 *
 * So {@link readLoadedDocumentNonce} stays exactly as load-bearing as it was (#2352
 * D1 review): the nonce PROP can be the other public route group's value after a soft
 * navigation between them, while the policy in force is the one that arrived with the
 * document. Read the document, not the prop.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    /**
     * Whether a `gtag('consent', 'default', …)` has already been pushed into THIS
     * DOCUMENT's `dataLayer`.
     *
     * On `window` rather than in a `useRef` because the scope that matters is the
     * document, not the component instance, and `window.dataLayer` — the thing the
     * flag describes — is document-scoped too. See the consent effect for what goes
     * wrong when the two scopes disagree.
     */
    __analyticsConsentDefaultPushed?: boolean;
  }
}

/**
 * The nonce the LOADED DOCUMENT's policy actually names.
 *
 * The `<Script>` below is `afterInteractive`, so it is injected by the browser after
 * hydration — and the policy it has to satisfy is the one that came with the
 * document, which never changes for the life of that document. The `nonce` PROP does
 * change: `(website)/layout.tsx` passes the fixed per-release value and
 * `(website-dynamic)/layout.tsx` passes the per-request one (#2352 D1), so a soft
 * navigation between the two public groups unmounts one layout and mounts the other,
 * and this component remounts holding the other territory's nonce while the loaded
 * document's policy still names the first.
 *
 * Not a security relaxation: the value read is the one already sitting in the DOM of
 * the document this script is about to run in, so nothing is learned that a script in
 * that document could not already see, and naming the WRONG nonce can only get our
 * own script refused — it can never make an injected one run.
 */
function readLoadedDocumentNonce(): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }

  for (const element of Array.from(document.getElementsByTagName("script"))) {
    // CSP nonce hiding blanks the content ATTRIBUTE once the document is parsed but
    // keeps the value on the IDL property, so `.nonce` is the one that answers in a
    // browser; `getAttribute` covers jsdom and anything without nonce hiding.
    const value = element.nonce || element.getAttribute("nonce");
    if (value) {
      return value;
    }
  }

  return undefined;
}

/**
 * Create `window.dataLayer` and the `gtag` shim if they do not exist yet, and return
 * the shim.
 *
 * This is the inline bootstrap snippet Google documents, moved into the bundle. A
 * push made before `gtag/js` loads is not lost: the library reads the existing array
 * on load and replays it in order, which is the whole reason the documented snippet
 * runs before the loader tag.
 */
function ensureGtag(): (...args: unknown[]) => void {
  window.dataLayer = window.dataLayer ?? [];
  if (!window.gtag) {
    window.gtag = function gtag(...args: unknown[]) {
      window.dataLayer?.push(args);
    };
  }
  return window.gtag;
}

/**
 * The consent categories, with advertising denied in every call, in both banner
 * modes, unconditionally — owner decision sections 3 and 4. No setting changes it,
 * and there is deliberately no advanced-consent-mode signal here.
 */
function consentCategories(analyticsGranted: boolean) {
  return {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: analyticsGranted ? "granted" : "denied",
  } as const;
}

/**
 * Google's own kill switch for a specific measurement ID.
 *
 * Needed because unmounting the `<Script>` does not unload a library the browser has
 * already executed: after an in-page opt-out the tag is still resident and would keep
 * sending automatically-collected events. Setting this flag is what "prevent further
 * Analytics collection as far as the supported implementation permits" (owner
 * section 5) actually means. It says nothing about data already sent, and this app
 * never claims otherwise.
 */
function setGaDisableFlag(measurementId: string, disabled: boolean) {
  (window as unknown as Record<string, unknown>)[
    `ga-disable-${measurementId}`
  ] = disabled;
}

/**
 * The club's canonical privacy policy, linked AT THE POINT OF THE DECISION (owner
 * decision section 2 item 4, clarification 5).
 *
 * A visitor being asked to make a privacy choice has to be able to read what the
 * club collects before answering, and until this existed there was no route to it
 * while the banner was asking: the banner is `fixed … bottom-0`, so it covers the
 * footer where the site's only Privacy Policy link lives, and the banner message
 * itself is plain text, so a URL an admin pastes into it is inert by design.
 *
 * `path` is `null` when the club has no PUBLISHED privacy page, and then this
 * renders nothing: a consent banner must not offer a link to a 404. There is no
 * Google-Analytics-specific URL setting — the path is the existing canonical
 * `/privacy` page, resolved server-side, the same one the footer links.
 */
function PrivacyPolicyLink({ path }: { path: string | null }) {
  if (!path) {
    return null;
  }
  return (
    <>
      {" "}
      <Link
        href={path}
        className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Privacy policy
      </Link>
    </>
  );
}

export function AnalyticsConsent({
  config,
  nonce,
}: {
  /** Resolved server-side; `null` means no analytics, for any reason. */
  config: AnalyticsRuntimeConfig | null;
  nonce?: string;
}) {
  const pathname = usePathname();
  // Resolved once per mount, from the document first and the server-rendered prop
  // only as a fallback (a `next start` with no proxy, or a document whose policy
  // carries no nonce at all). A lazy `useState` initialiser rather than an effect:
  // the script is injected on the first client render, so a value that arrived one
  // render later would come too late to be stamped.
  const [scriptNonce] = useState(() => readLoadedDocumentNonce() ?? nonce);
  const [stored, setStored] = useState<StoredConsent | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  const measurementId = config?.measurementId;
  const consentRevision = config?.consentRevision;

  // `usePathname()` returns null when no router context is mounted. Treat that as
  // ineligible: fail closed.
  const routeEligible =
    typeof pathname === "string" && isAnalyticsEligiblePath(pathname);

  const decision = config
    ? resolveAnalyticsDecision(config, stored)
    : { analyticsAllowed: false, showBanner: false, preference: "unset" as const };

  // Whether the VISITOR's position allows analytics, with the route gate deliberately
  // left out. Split from `analyticsAllowed` because the page-view effect below has to
  // tell "this visitor has withdrawn consent" apart from "this particular address is
  // not one we report" — the two look identical to the tag and are not the same fact.
  //
  // `hydrated` is part of the gate rather than a cosmetic guard: before the storage
  // read resolves we do not know whether this visitor declined, and loading on the
  // strength of "no record yet" would be a load without consent.
  const consentAllowsAnalytics =
    Boolean(config) && hydrated && decision.analyticsAllowed;
  // The tag loads only when consent allows it AND the address is one analytics runs on.
  const analyticsAllowed = consentAllowsAnalytics && routeEligible;
  const bannerVisible =
    Boolean(config) && routeEligible && hydrated && decision.showBanner;
  // The preferences control is offered wherever the runtime is mounted and the club
  // is validly configured, INCLUDING a route analytics does not run on: a visitor
  // who wants to opt out should not have to find a tracked page first. Only the
  // banner and the tag are route-gated.
  const preferencesAvailable = Boolean(config) && hydrated;

  // Read storage once per mount, and again if the club's revision changes under a
  // long-lived tab (a revalidated layout can hand down a new one without a reload).
  useEffect(() => {
    if (!config) {
      setHydrated(false);
      return;
    }
    setStored(readStoredConsent());
    setHydrated(true);
  }, [config, consentRevision]);

  /*
    The visitor's choice is stored per BROWSER, so it has to take effect in every
    tab of it — not only the one the choice was made in.

    Without this, a visitor with two public pages open who selects "Turn analytics
    off" in one of them has stopped collection in that tab only: the other tab
    re-reads nothing, its `ga-disable-<id>` flag stays false, and its resident tag
    carries on sending the automatically-collected events (engagement, scroll,
    outbound clicks, form interactions) for the life of the tab — while the
    preferences panel has just told them "Switching analytics off stops further
    collection from this browser". Owner section 5 asks for further collection to be
    prevented "as far as the supported implementation permits", and the `storage`
    event is supported, so per-tab-only is short of that rather than at its limit.

    `storage` fires in the OTHER tabs of the same origin, never in the one that
    wrote, which is exactly the gap. A `null` key means the whole store was cleared
    (`localStorage.clear()`), so that re-reads too. The re-read feeds the same
    decision path as any other change, so the consent effect below denies consent
    and sets Google's kill switch in the other tab with no further work. It fixes
    the symmetric direction as well: an Accept or Decline in one tab is now honoured
    in the others without a reload.
  */
  useEffect(() => {
    if (!config) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== ANALYTICS_CONSENT_STORAGE_KEY) {
        return;
      }
      setStored(readStoredConsent());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [config]);

  /*
    Consent signalling and tag configuration, in ONE effect declared BEFORE the
    page-view effect below — the order is load-bearing.

    Everything goes onto `window.dataLayer` in push order and `gtag/js` replays that
    queue when it loads, so the queue has to read the way Google's documented inline
    snippets read: consent first, then `js`/`config`, then events. An event queued
    ahead of its `config` is attributed to no measurement ID.

    The FIRST consent push is a `default` and every later one an `update`, which is
    the documented pair: `default` states the position the page starts from, `update`
    records a change the visitor made. Both are local array pushes; neither is a
    network call, and neither reaches Google before the loader below is mounted.

    "FIRST" is per DOCUMENT, not per component instance, and that distinction is the
    whole reason the flag lives on `window`. gtag honours `consent default` only
    BEFORE the library initialises; once `gtag/js` has run, a later `default` is
    ignored and only an `update` moves the position. A per-instance ref gets this
    wrong on a cross-group round trip — the visitor accepts on the public website,
    soft-navigates to `/dashboard` (which unmounts this component and queues the
    denial the cleanup effect below owes), then comes back, and the fresh instance's
    ref is false again, so it pushes `default(granted)` into a document whose
    resident library has already initialised. The queue reads
    `default(granted), update(denied), default(granted)` and the tag stays DENIED for
    the life of the tab: analytics degrades to cookieless pings for a visitor who
    explicitly accepted, which is section 3's "Accept should enable Analytics" not
    holding. Wrong in the private direction rather than the dangerous one, but wrong.

    Keying on the document makes the second mount push `update(granted)`, which is
    honoured. It is also the right answer when the library never loaded: the queue
    then holds `default(denied), update(granted)` and `gtag/js` replays both in order
    when it finally arrives, landing on granted.
  */
  const configuredMeasurementIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!measurementId || !hydrated) return;

    const gtag = ensureGtag();
    if (window.__analyticsConsentDefaultPushed) {
      gtag("consent", "update", consentCategories(analyticsAllowed));
    } else {
      gtag("consent", "default", consentCategories(analyticsAllowed));
      window.__analyticsConsentDefaultPushed = true;
    }

    setGaDisableFlag(measurementId, !analyticsAllowed);

    if (analyticsAllowed && configuredMeasurementIdRef.current !== measurementId) {
      gtag("js", new Date());
      gtag("config", measurementId, {
        anonymize_ip: true,
        // Google's own page view would use the raw `location.href`. Ours is the
        // sanitised one; this is what stops both being sent.
        send_page_view: false,
      });
      configuredMeasurementIdRef.current = measurementId;
    }
  }, [analyticsAllowed, hydrated, measurementId]);

  /*
    UNMOUNTING has to disable the tag, because it cannot unload it.

    `next/script` unmounting removes an element; it does not — and cannot — unload a
    library the browser has already executed. So without this the tag stays resident
    with `ga-disable-<id> === false` and no denial queued, and it keeps sending the
    events GA4 collects on its own.

    That is not a hypothetical: this runtime is mounted by the two PUBLIC WEBSITE
    layouts only. The `(public)`, `(authenticated)`, `(admin)`, `(finance)` and
    `(lodge)` groups mount nothing analytics-related, and the public header's own
    primary calls to action are `next/link` soft navigations straight into them —
    "Log In" to `/login` for a visitor, "Dashboard" or "Book Now" to `/dashboard`
    and `/book` for a signed-in member. React unmounts this component on that
    navigation, so a tag left enabled would go on collecting across exactly the
    "authenticated member or dashboard routes" and "login recovery routes" that owner
    section 7 excludes — and `form_start`/`form_submit` carry the form's resolved
    action URL, i.e. a member-area address. A full page load into those groups was
    always clean; the soft navigation was not.

    Its own effect, keyed on `measurementId` alone, so the cleanup runs on UNMOUNT
    and on a changed measurement ID — not on every consent flip, where the effect
    above already re-states the correct position and an extra denial would only add
    noise to the queue. On a changed ID the closure disables the OLD id, which is the
    right one to disable; the effect above then enables the new one if allowed. On a
    cross-group remount the new instance sets the flag from its own route
    eligibility, so leaving it disabled here is always the safe order.

    Guarded on the same document-scoped flag as the effect above: if NOTHING in this
    document ever bootstrapped gtag (no measurement ID anywhere, or storage never
    resolved) there is no tag to disable, and creating `window.dataLayer` on the way
    out would be pure noise. Document scope is the right scope here too — an instance
    that never pushed a default itself, mounted after one that did, is still leaving
    the public website with a resident tag that has to be switched off.
  */
  useEffect(() => {
    if (!measurementId) return;
    return () => {
      if (!window.__analyticsConsentDefaultPushed) return;
      setGaDisableFlag(measurementId, true);
      ensureGtag()("consent", "update", consentCategories(false));
    };
  }, [measurementId]);

  /*
    One sanitised page view per eligible navigation, never a duplicate.

    Google's automatic page view is switched off in the `config` call above, so this
    is the ONLY page view sent — which is what makes both guarantees hold at once: the
    URL is sanitised (no query, no fragment, no identifiers) and a client-side
    navigation cannot produce a second view of the same address. The ref holds the
    last location actually SENT, so a re-render, or a step onto an address analytics
    does not report and back again, sends nothing.

    WITHDRAWN CONSENT is the one thing that clears that memory, and the distinction is
    deliberate. A visitor who opens the preferences panel, turns analytics off and then
    turns it back on without moving used to contribute nothing at all for the page they
    were sitting on: the ref still held that address, so the re-grant sent no page view,
    and GA4 needs one to open the session — so the visitor was measured from their next
    navigation onwards, or never, if they read the page and left. Clearing on withdrawal
    means a fresh grant starts counting from wherever the visitor actually is.

    It cannot double-send for one navigation: the ref is written synchronously in the
    same effect that sends, and only a consent change clears it. An INELIGIBLE ADDRESS
    deliberately does NOT clear it, which is why `consentAllowsAnalytics` is gated
    separately from `routeEligible` above — a detour through a page analytics does not
    report is not a consent event, and treating it as one would re-report the address
    the visitor came back to.
  */
  const lastPageViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!consentAllowsAnalytics) {
      lastPageViewRef.current = null;
      return;
    }
    if (!analyticsAllowed || typeof pathname !== "string") return;

    const pageLocation = buildAnalyticsPageLocation(
      window.location.origin,
      pathname,
    );
    if (!pageLocation || lastPageViewRef.current === pageLocation) return;

    const pageReferrer = sanitiseAnalyticsReferrer(
      document.referrer,
      window.location.origin,
    );
    const payload = {
      page_location: pageLocation,
      ...(pageReferrer ? { page_referrer: pageReferrer } : {}),
    };
    const gtag = ensureGtag();
    // `set` first so any event Google's enhanced measurement sends on its own
    // (scroll, outbound click, site search) inherits the sanitised values instead of
    // reading `location.href` for itself.
    gtag("set", payload);
    gtag("event", "page_view", payload);
    lastPageViewRef.current = pageLocation;
  }, [analyticsAllowed, consentAllowsAnalytics, pathname]);

  // Publish the banner's visibility so a co-located bottom-corner widget (the public
  // help launcher, epic #2094 C2) can step aside while it shows. A data attribute for
  // the initial read plus an event for reactive updates.
  useEffect(() => {
    const root = document.documentElement;
    if (bannerVisible) {
      root.setAttribute("data-analytics-consent-banner", "visible");
    } else {
      root.removeAttribute("data-analytics-consent-banner");
    }
    window.dispatchEvent(
      new CustomEvent("analytics-consent-visibility", {
        detail: { visible: bannerVisible },
      }),
    );
    return () => {
      root.removeAttribute("data-analytics-consent-banner");
      // ANNOUNCE the withdrawal as well as removing the attribute. A listener that
      // subscribed to the event has no reason to re-read the attribute, so clearing
      // one channel and not the other leaves it holding the last value it was told.
      window.dispatchEvent(
        new CustomEvent("analytics-consent-visibility", {
          detail: { visible: false },
        }),
      );
    };
  }, [bannerVisible]);

  // Publish whether a preferences control should be offered, and listen for the
  // footer link asking to open it. See `analytics-preferences-channel.ts`.
  useEffect(() => {
    const root = document.documentElement;
    if (preferencesAvailable) {
      root.setAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE, "available");
    } else {
      root.removeAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE);
    }
    window.dispatchEvent(
      new CustomEvent(ANALYTICS_PREFERENCES_AVAILABILITY_EVENT, {
        detail: { available: preferencesAvailable },
      }),
    );
    /*
      Announced on the way out too, not just removed from the DOM.

      This runtime is mounted only by the two public WEBSITE layouts, but the FOOTER
      that carries the preferences link is also rendered by the `(public)` layout — the
      login, recovery and token-bearing group, which mounts no analytics runtime at all.
      A soft navigation from the website into that group therefore unmounts this
      component while a fresh `AnalyticsPreferencesLink` mounts, and that link decides
      whether to render by reading the attribute on mount. Removing the attribute is
      what makes it stay hidden, and it works only because React runs this destroy
      function before the new tree's effects; dispatching the event as well means the
      answer no longer rests on that ordering, and any already-mounted listener is told
      outright. A visible link there would be a button with nothing behind it: the panel
      it opens belongs to the component that has just gone.
    */
    return () => {
      root.removeAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE);
      window.dispatchEvent(
        new CustomEvent(ANALYTICS_PREFERENCES_AVAILABILITY_EVENT, {
          detail: { available: false },
        }),
      );
    };
  }, [preferencesAvailable]);

  useEffect(() => {
    if (!preferencesAvailable) return;
    const open = () => setPreferencesOpen(true);
    window.addEventListener(ANALYTICS_PREFERENCES_OPEN_EVENT, open);
    return () => {
      window.removeEventListener(ANALYTICS_PREFERENCES_OPEN_EVENT, open);
    };
  }, [preferencesAvailable]);

  /*
    Record a choice, and report whether the browser agreed to KEEP it.

    `writeStoredConsent` returns false when `localStorage` refuses the write —
    storage fully blocked, a partitioned or embedded context, zero quota. Those
    browsers throw on the read as well, so the choice cannot come back on the next
    page load.

    Banner-ON mode needs nothing said about it: the read returns "no choice
    recorded", the banner asks again, and nothing loads until the visitor accepts.
    Banner-OFF mode is the opposite — with no stored record `resolveAnalyticsDecision`
    answers "analytics allowed", so an opt-out made through the preferences panel
    holds for this page and then stops holding, while the panel has just told the
    visitor that "switching analytics off stops further collection from this
    browser". The implementation cannot preserve the opt-out in that browser (owner
    section 5's "preserved for future eligible page loads"), so what it must not do
    is claim it did. The panel keeps itself open and says so instead.
  */
  const [storageRefused, setStorageRefused] = useState(false);
  const record = useCallback(
    (choice: ConsentChoice, source: ConsentSource) => {
      if (!consentRevision) return false;
      const next: StoredConsent = { choice, revision: consentRevision, source };
      setStored(next);
      const persisted = writeStoredConsent(next);
      setStorageRefused(!persisted);
      return persisted;
    },
    [consentRevision],
  );

  if (!config) {
    return null;
  }

  return (
    <>
      {analyticsAllowed && measurementId && (
        <Script
          id="ga4-loader"
          nonce={scriptNonce}
          src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(
            measurementId,
          )}`}
          strategy="afterInteractive"
        />
      )}

      {bannerVisible && (
        <div
          role="dialog"
          aria-label="Analytics cookie consent"
          className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card px-4 py-4 shadow-lg backdrop-blur"
        >
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 sm:flex-row sm:items-center">
            <BarChart3
              aria-hidden="true"
              className="hidden h-5 w-5 shrink-0 text-muted-foreground sm:block"
            />
            {/* Admin-authored plain text, rendered as a React text child. Never
                dangerouslySetInnerHTML: HTML or Markdown in the saved message is
                shown literally rather than interpreted. A URL pasted into the
                message is therefore inert, which is why the policy link beside it
                is code-rendered from the canonical configuration. */}
            <p className="flex-1 text-sm leading-6 text-muted-foreground">
              {config.bannerMessage}
              <PrivacyPolicyLink path={config.privacyPolicyPath} />
            </p>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button type="button" onClick={() => record("accepted", "banner")}>
                Accept
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => record("declined", "banner")}
              >
                Decline
              </Button>
              <button
                type="button"
                aria-label="Close analytics consent banner"
                onClick={() => record("declined", "banner")}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={preferencesOpen} onOpenChange={setPreferencesOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Analytics preferences</DialogTitle>
            <DialogDescription>
              {decision.preference === "allowed"
                ? "Google Analytics is currently allowed on this website in this browser."
                : decision.preference === "declined"
                  ? "Google Analytics is currently switched off on this website in this browser."
                  : "You have not yet chosen whether Google Analytics may run on this website."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Analytics helps us understand how this website is used. Your choice is
              stored in this browser only, and you can change it at any time.
            </p>
            <p>
              Switching analytics off stops further collection from this browser. It
              does not remove information already sent to Google.
              <PrivacyPolicyLink path={config.privacyPolicyPath} />
            </p>
            {/*
              Only ever populated after a click whose write was REFUSED, which is why
              the panel stays open below rather than closing on the choice. Plain
              about both halves: the choice is in force now, and it will not come
              back. Deliberately not a claim about what to do instead — the browser
              setting that blocked the write is the visitor's own.

              The `role="status"` WRAPPER is mounted unconditionally and only its
              content is gated, the same shape as `PolicyFeedback` and
              `AdminViewOnlySectionBanner`: a live region injected already-populated
              in a single mutation is announced by some screen-reader/browser
              pairings and silently dropped by others. The dialog mounts on open, so
              the region is registered from the panel's first paint and the note
              lands as a content change inside it.
            */}
            <div role="status">
              {storageRefused ? (
                <p className="text-foreground">
                  This browser would not let us save your choice, so it applies to
                  this page only and will not be remembered the next time you visit.
                  That is usually private browsing, or a setting that blocks website
                  storage.
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                // Close only when the choice was actually stored: otherwise the note
                // above is the thing the visitor needs to read, and dismissing the
                // panel would hide it.
                if (record("declined", "preferences")) {
                  setPreferencesOpen(false);
                }
              }}
            >
              Turn analytics off
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (record("accepted", "preferences")) {
                  setPreferencesOpen(false);
                }
              }}
            >
              Allow analytics
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
