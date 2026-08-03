"use client";

import Script from "next/script";
import { useEffect, useMemo, useState } from "react";
import { BarChart3, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const CONSENT_STORAGE_KEY = "analytics-consent.v1";

type ConsentChoice = "accepted" | "declined";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

function readConsent(): ConsentChoice | null {
  try {
    const stored = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return stored === "accepted" || stored === "declined" ? stored : null;
  } catch {
    return null;
  }
}

function writeConsent(choice: ConsentChoice) {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    // Private browsing / quota errors: the current render still honors choice.
  }
}

function updateAnalyticsConsent(choice: ConsentChoice) {
  window.dataLayer = window.dataLayer ?? [];
  window.gtag =
    window.gtag ??
    function gtag(...args: unknown[]) {
      window.dataLayer?.push(args);
    };
  window.gtag("consent", "update", {
    analytics_storage: choice === "accepted" ? "granted" : "denied",
  });
}

/**
 * The nonce the LOADED DOCUMENT's policy actually names.
 *
 * Every `<Script>` below is `afterInteractive`, so it is injected by the browser
 * after hydration — and the policy it has to satisfy is the one that came with the
 * document, which never changes for the life of that document. The `nonce` PROP does
 * change: `(website)/layout.tsx` passes the fixed per-release value and
 * `(website-dynamic)/layout.tsx` passes the per-request one (#2352 D1), so a soft
 * navigation between the two public groups unmounts one layout and mounts the other,
 * and this component remounts holding the other territory's nonce while the loaded
 * document's policy still names the first. `script-src` has no `'strict-dynamic'`, so
 * a dynamically injected INLINE script is nonce-checked: the result was `gtag` loaded
 * and never configured, one console CSP error and no other symptom. The same shape
 * predates the split on `/` -> `/login` (`(public)/layout.tsx` passes a per-request
 * value too), so reading the document closes both.
 *
 * Not a security relaxation: the value read is the one already sitting in the DOM of
 * the document these scripts are about to run in, so nothing is learned that a script
 * in that document could not already see, and naming the WRONG nonce can only get our
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

export function AnalyticsConsent({
  enabled,
  measurementId,
  nonce,
}: {
  enabled: boolean;
  measurementId?: string;
  nonce?: string;
}) {
  const cleanMeasurementId = measurementId?.trim();
  // Resolved once per mount, from the document first and the server-rendered prop
  // only as a fallback (a `next start` with no proxy, or a document whose policy
  // carries no nonce at all). A lazy `useState` initialiser rather than an effect:
  // these scripts are injected on the first client render, so a value that arrived
  // one render later would come too late to be stamped.
  const [scriptNonce] = useState(() => readLoadedDocumentNonce() ?? nonce);
  const [choice, setChoice] = useState<ConsentChoice | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const shouldRender = enabled && Boolean(cleanMeasurementId);
  const accepted = shouldRender && choice === "accepted";
  const consentBootstrap = useMemo(
    () => `
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  wait_for_update: 500
});
`,
    [],
  );
  const gaConfig = useMemo(
    () => `
gtag('js', new Date());
gtag('config', ${JSON.stringify(cleanMeasurementId)}, { anonymize_ip: true });
`,
    [cleanMeasurementId],
  );

  useEffect(() => {
    if (!shouldRender) return;
    const stored = readConsent();
    setChoice(stored);
    setHydrated(true);
    if (stored) updateAnalyticsConsent(stored);
  }, [shouldRender]);

  // Publish the banner's visibility so a co-located bottom-corner widget (the
  // public help launcher, epic #2094 C2) can step aside while it shows. A data
  // attribute for the initial read plus an event for reactive updates — the same
  // signal the banner already drives, not a duplicated storage check.
  const bannerVisible = shouldRender && hydrated && choice === null;
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
    };
  }, [bannerVisible]);

  if (!shouldRender) {
    return null;
  }

  function setConsent(nextChoice: ConsentChoice) {
    setChoice(nextChoice);
    writeConsent(nextChoice);
    updateAnalyticsConsent(nextChoice);
  }

  return (
    <>
      <Script id="ga-consent-default" nonce={scriptNonce} strategy="afterInteractive">
        {consentBootstrap}
      </Script>

      {accepted && (
        <>
          <Script
            id="ga4-loader"
            nonce={scriptNonce}
            src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(
              cleanMeasurementId as string,
            )}`}
            strategy="afterInteractive"
          />
          <Script id="ga4-config" nonce={scriptNonce} strategy="afterInteractive">
            {gaConfig}
          </Script>
        </>
      )}

      {hydrated && choice === null && (
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
            <p className="flex-1 text-sm leading-6 text-muted-foreground">
              We use optional Google Analytics to understand aggregate site use.
              It runs only if you accept.
            </p>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button type="button" onClick={() => setConsent("accepted")}>
                Accept
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConsent("declined")}
              >
                Decline
              </Button>
              <button
                type="button"
                aria-label="Close analytics consent banner"
                onClick={() => setConsent("declined")}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
