import Link from "next/link";
import { BookOpen, LayoutTemplate, Tv, Wand2 } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  DISPLAY_WIZARD_HREF,
  shouldLeadWithSetupCard,
} from "./setup/display-wizard-state";
import {
  DISPLAY_GLOSSARY_LEAD,
  DISPLAY_TERM_BOARD,
  DISPLAY_TERM_LAYOUT,
  DISPLAY_TERM_TEMPLATE,
} from "@/lib/lodge-display/display-terminology";

// Lobby Display hub (fork issue #109): one sidebar entry opens this landing
// page of cards instead of the old four-item sidebar group. Mirrors the
// "Site Appearance & Content" hub (/admin/appearance) — the Devices management
// page now lives at /admin/display/devices; the other cards keep their routes.
//
// #2247: the cards now OPEN with the definition of the word each one is about.
// The admin used three words — Layout, Template, board — for two database rows
// and defined none of them, and the hub is the first place an operator meets
// all three. The definitions come from `display-terminology.ts` so the hub, the
// Reference page and `docs/guides/display.md` cannot drift apart.
const sections: AdminHubSection[] = [
  {
    href: "/admin/display/devices",
    title: "Devices",
    description:
      "Pair lobby screens per lodge, assign templates, and set each device's refresh interval.",
    icon: Tv,
  },
  {
    href: "/admin/display/builder",
    title: "Visual builder",
    description: `${DISPLAY_TERM_BOARD.oneLiner} Compose one by picking a shape and dropping modules into zones — no HTML. Writes a valid Layout + Template for you.`,
    icon: LayoutTemplate,
    // The builder's Live preview needs the route-scoped `frame-src 'self'`
    // relaxation from `src/lib/csp.ts`, and CSP only changes on a hard document
    // load — a soft `<Link>` navigation would carry this hub's stricter policy
    // into the builder and the preview would show "Content blocked" (#2246).
    hardNavigate: true,
  },
  {
    href: "/admin/display/layouts",
    title: "Layouts (Advanced)",
    description: `${DISPLAY_TERM_LAYOUT.oneLiner} Advanced mode: author one by hand.`,
    icon: LayoutTemplate,
  },
  {
    href: "/admin/display/templates",
    title: "Templates",
    description: `${DISPLAY_TERM_TEMPLATE.oneLiner} Author one here, or restore the built-in boards.`,
    icon: LayoutTemplate,
  },
  {
    href: "/admin/display/reference",
    title: "Reference",
    description:
      "The read-only display vocabulary: embeddable modules, area conditions, and CSS tokens.",
    icon: BookOpen,
  },
];

/**
 * The guided setup wizard as an ORDINARY hub card. Appended only when the gold
 * lead card is not showing, so the wizard has a real, clickable entry point on
 * the hub at all times (#2249) without appearing twice: it leads while the club
 * has no boards or no working screen, and drops back into the grid once a screen
 * is live — which is exactly when a club replacing a TV needs to find it again.
 */
const guidedSetupSection: AdminHubSection = {
  href: DISPLAY_WIZARD_HREF,
  title: "Guided setup",
  description:
    "Re-run the six-step path — module, boards, pick one, lodge details, pair the screen — after replacing a TV or setting up another lodge.",
  icon: Wand2,
};

/**
 * The guided-setup front door (#2249). Shown only while the club has no boards
 * or no working screen — the state where the five cards below are a puzzle
 * rather than a menu. Once a screen is live it disappears, and the wizard stays
 * reachable from the Help panel on any Lobby Display page.
 */
function GuidedSetupCard() {
  return (
    <Link href={DISPLAY_WIZARD_HREF} className="group block">
      <Card className="border-brand-gold/70 hover:border-brand-gold">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 shrink-0 text-foreground" />
            <CardTitle>Guided setup — nothing on your screens yet</CardTitle>
          </div>
          <CardDescription>
            Go from &ldquo;module off&rdquo; to a TV showing the right board,
            one step at a time: turn the module on, restore the built-in boards,
            pick one, fill in the lodge details it prints, then pair the screen.
            About ten minutes, and you can stop and resume.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <span className="text-sm font-medium underline underline-offset-4">
            Start setup
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

export default async function DisplayHubPage() {
  const [features, templateCount, pairedDeviceCount] = await Promise.all([
    loadEffectiveModuleFlags(),
    prisma.displayTemplate.count(),
    // Only a screen that is paired AND not revoked counts as working: a device
    // row created but never paired shows nothing on a wall.
    prisma.lodgeDisplayDevice.count({
      where: { tokenHash: { not: null }, revokedAt: null },
    }),
  ]);

  const leadWithSetup = shouldLeadWithSetupCard({
    templateCount,
    pairedDeviceCount,
  });

  return (
    <AdminHubPage
      title="Lobby Display"
      description={`Pair the screens in your lodges and author what they show. ${DISPLAY_GLOSSARY_LEAD}`}
      sections={leadWithSetup ? sections : [...sections, guidedSetupSection]}
      features={features}
      lead={leadWithSetup ? <GuidedSetupCard /> : null}
    />
  );
}
