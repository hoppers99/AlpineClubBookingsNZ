import Link from "next/link";
import { BackLink } from "@/components/admin/back-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getClubThemeForAdmin } from "@/lib/club-theme";
import { loadSetupSurfaceSettings } from "@/lib/setup-surface-settings";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { SiteStyleWizard } from "./site-style-wizard";

export default async function SiteStylePage() {
  // The legacy-surfaces switch reaches this page too (epic #213, C8 #223): its
  // "Finish setup" control is the SECOND lever that makes the public site
  // visible, and it retires with the surfaces it belongs to, leaving the
  // wizard's Ready-to-open panel as the one deliberate act (D9).
  const [theme, surfaceSettings] = await Promise.all([
    getClubThemeForAdmin(),
    loadSetupSurfaceSettings(),
  ]);

  return (
    <div className={`space-y-8 ${clubThemeFontVariableClassName}`}>
      <div>
        <BackLink href="/admin/appearance" label="Site Appearance & Content" />
        <h1 className="mt-2 text-2xl font-bold text-foreground">Site Style</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set the brand colours and fonts used by the public website, member area,
          and admin area, plus the public logo.
        </p>
        <p className="mt-2 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
          {surfaceSettings.legacySurfacesHidden
            ? "The public site — including the membership application form — stays hidden until you open it from the setup wizard's Ready to open screen. Saving here stores the styling; it does not make the site live."
            : "The public site — including the membership application form — stays hidden until this is saved."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Club Identity</CardTitle>
          <CardDescription>
            Visual branding is managed here. Club name, public URL, email names,
            and message wording stay with the existing configuration settings.
            Operational status colours are curated and remain fixed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 text-sm">
          <Link
            href="/admin/setup"
            className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Setup
          </Link>
          <Link
            href="/admin/email-messages"
            className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Email messages
          </Link>
        </CardContent>
      </Card>

      <SiteStyleWizard
        initialTheme={theme}
        legacySurfacesHidden={surfaceSettings.legacySurfacesHidden}
      />
    </div>
  );
}
