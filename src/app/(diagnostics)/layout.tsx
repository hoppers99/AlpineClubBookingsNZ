/**
 * THE DIAGNOSTICS WORKSPACE LAYOUT (AID-7, #2378; owner decision Q4).
 *
 * Diagnostics gets its own workspace rather than inheriting the admin sidebar and
 * chrome, because it is a separate investigation product and not another admin
 * screen. That is a decision about what this page LOOKS like.
 *
 * IT IS NOT A DECISION ABOUT SECURITY, and this file exists in a separate route
 * group precisely so that distinction has to be made deliberately. It clears the
 * SAME admin gauntlet as `(admin)/layout.tsx` — session, a member re-read fresh from
 * the database, active account, forced password change, two-factor gate, and area
 * permission for the requested path — by calling the same `guardAdminLayout`. There
 * is no second copy of that sequence, and `admin-layout-guard-adoption.test.ts`
 * fails if one appears here.
 *
 * A ROUTE GROUP IS NOT A SECURITY BOUNDARY, and #2378 says so explicitly. Putting
 * this in `(diagnostics)` changes which layout renders and nothing else: it grants
 * nothing, gates nothing, and is invisible in the URL. The boundary is the guard
 * above and the per-invocation checks the tool substrate already performs on every
 * single call. Anyone reading this file should not come away thinking the parentheses
 * did any work.
 *
 * OPENING THE SHELL GRANTS NO EVIDENCE PERMISSION. Any admitted administrator may
 * open this workspace — that is deliberate (owner decision Q6, and the
 * `OVERVIEW_ALLOWLIST` entry in `admin-route-map-drift.test.ts` records the
 * reasoning). What they can then ASK is decided per tool invocation, freshly, from
 * the server-side matrix, and the answer to "may I read this booking" has nothing to
 * do with whether this page rendered.
 */

import { redirect } from "next/navigation";

import { AppProviders } from "@/components/app-providers";
import { guardAdminLayout } from "@/lib/admin-layout-guard";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import { getCachedClubIdentity } from "@/lib/public-layout-config";

export default async function DiagnosticsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const guard = await guardAdminLayout();
  if (guard.outcome === "redirect") redirect(guard.destination);

  const [theme, lodgeCapacity, clubIdentity] = await Promise.all([
    getWebsiteThemeRenderState(),
    getDefaultLodgeCapacity(),
    getCachedClubIdentity(),
  ]);

  return (
    <AppProviders
      clubIdentity={{ ...clubIdentity, lodgeCapacity }}
      nonce={guard.nonce}
    >
      <div
        className={`${clubThemeFontVariableClassName} app-theme-scope flex min-h-screen flex-col bg-background text-foreground`}
      >
        <style
          dangerouslySetInnerHTML={{ __html: theme.appCss }}
          data-site-style="club-theme"
        />
        {/* Kept even though this workspace has no sidebar: a keyboard user landing
            here still needs a way past the header, and the admin layout's skip link
            is not inherited. */}
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
          href="#diagnostics-main"
        >
          Skip to main content
        </a>
        <main
          id="diagnostics-main"
          tabIndex={-1}
          className="flex-1 overflow-y-auto p-6 md:p-8"
        >
          {children}
        </main>
      </div>
    </AppProviders>
  );
}
