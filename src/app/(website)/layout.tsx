import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { HelpWidgetPublic } from "@/components/help-widget/help-widget-public";
import { SiteBanners } from "@/components/site-banners";
import { WebsiteHeader } from "@/components/website-header";
import { WebsiteFooter } from "@/components/website-footer";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  getCachedClubIdentity,
  getCachedWebsiteThemeRenderState,
} from "@/lib/public-layout-config";
import { getCurrentSiteBanners } from "@/lib/site-banners";
import { SETUP_IN_PROGRESS_COPY } from "@/lib/setup-in-progress-screen";

function resolvePageSlug(requestHeaders: Headers) {
  return requestHeaders.get("x-page-slug") ?? "home";
}

export default async function WebsiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, theme, requestHeaders, siteBanners, modules] =
    await Promise.all([
      auth(),
      // Tagged cache wrapper, matching (public)/layout.tsx (#2322): this layout
      // previously re-read ClubTheme from the database on every request. The
      // `public-layout:theme` tag is revalidated on theme save by the
      // admin/site-style PUT.
      getCachedWebsiteThemeRenderState(),
      headers(),
      getCurrentSiteBanners(),
      loadEffectiveModuleFlags(),
      // NOTE: the club identity is NOT fetched here. It is used only by the
      // pre-setup branch below, which since #2420 is a rare fallback rather than
      // the pre-setup norm, so it is resolved inside that branch — the same
      // treatment loadEmailMessageSettings() already gets, and for the same
      // reason: keep the hot path's read set to what it actually renders.
    ]);
  const pageSlug = resolvePageSlug(requestHeaders);
  const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;
  const themeStyle = (
    <style
      dangerouslySetInnerHTML={{ __html: theme.css }}
      data-site-style="club-theme"
    />
  );

  if (!theme.isComplete && !theme.readFailed) {
    // FALLBACK, not the main path (#2420). `src/proxy.ts` answers every
    // public-website address with 503 and this same screen while setup is
    // incomplete, so an ordinary request never gets here.
    //
    // What still does is a URL the proxy RUNS on but the gate does not CLAIM.
    // (#2404 removed the matcher's prefetch exemption entirely, so the header
    // route in — `purpose: prefetch`, with or without `RSC` — is closed; there
    // is no header a caller can set that skips the proxy.) The gate refuses
    // asset-extension paths on purpose, because the holding screen is an HTML
    // document and must never answer a request for an image, so any such URL
    // that reaches a render lands here ungated: `/API/x.png` is the live case,
    // claimed by no rewrite rule (the general rule's `(?!api/)` lookahead is
    // case-insensitive) and matched by no `/api` route either, because Next's
    // route table is case-sensitive. This branch is what stops those
    // seeing the real site. Those responses are still 200, because a layout
    // cannot set a status; that is the whole reason the authoritative decision
    // moved to the proxy.
    //
    // `!readFailed` is the other half, and the asymmetry with the proxy gate is
    // deliberate (#2420 review F4). The gate answers an unreadable database with
    // 503, which is exactly what 503 means. This layout's only available answer
    // is a 200, and a 200 saying "site setup in progress" is a claim about the
    // CLUB, not about the request — one that `/`'s anonymous cache entry would
    // then repeat for 60 seconds (300 stale) after a two-second blip on a club
    // that launched years ago. So the holding screen is painted only when the
    // database positively reports an unfinished setup. A failed read falls
    // through to the real site, whose own queries then fail honestly.
    //
    // DB-first contact address (C6 #1985): resolved only when the pre-setup
    // fallback screen actually renders, so the hot website layout adds no extra
    // query on the normal path. Reads EmailMessageSetting.contactEmail with the
    // config default as fallback — never a synchronous club.json read. The
    // setup gate reads the same two sources so the two screens can never name
    // the club or the contact address differently.
    const [{ contactEmail }, clubIdentity] = await Promise.all([
      loadEmailMessageSettings(),
      getCachedClubIdentity(),
    ]);
    return (
      <div
        className={`${clubThemeFontVariableClassName} website-theme min-h-screen bg-background text-foreground`}
      >
        {themeStyle}
        <main className="flex min-h-screen items-center justify-center px-4 py-16">
          <section className="mx-auto max-w-2xl text-center">
            <p className="website-eyebrow mb-4">
              {SETUP_IN_PROGRESS_COPY.eyebrow}
            </p>
            <h1 className="font-heading text-4xl font-bold text-brand-charcoal sm:text-5xl">
              {SETUP_IN_PROGRESS_COPY.heading(clubIdentity.name)}
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-brand-deep/80 sm:text-lg">
              {SETUP_IN_PROGRESS_COPY.body}
            </p>
            <p className="mt-6 text-sm text-brand-ridge">
              {SETUP_IN_PROGRESS_COPY.contactPrefix}{" "}
              <a
                href={`mailto:${contactEmail}`}
                className="font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
              >
                {contactEmail}
              </a>
            </p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div
      className={`${clubThemeFontVariableClassName} website-theme min-h-screen flex flex-col bg-background text-foreground`}
    >
      {themeStyle}
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
        href="#main-content"
      >
        Skip to main content
      </a>
      <SiteBanners banners={siteBanners} />
      <WebsiteHeader
        isAuthenticated={!!session?.user}
        logoUrl={theme.logoUrl}
        logoDataUrl={theme.logoDataUrl}
      />
      <main className="flex-1" id="main-content">{children}</main>
      <WebsiteFooter
        logoUrl={theme.logoUrl}
        logoDataUrl={theme.logoDataUrl}
        pageSlug={pageSlug}
      />
      <AnalyticsConsent
        enabled={modules.analytics}
        measurementId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}
        nonce={nonce}
      />
      {/* Public help widget: hardcoded llmEnabled=false; hides itself while the
          AnalyticsConsent banner occupies the same bottom corner. */}
      <HelpWidgetPublic />
    </div>
  );
}
