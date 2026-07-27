import { BookOpen, LayoutTemplate, Tv } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
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

export default async function DisplayHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <AdminHubPage
      title="Lobby Display"
      description={`Pair the screens in your lodges and author what they show. ${DISPLAY_GLOSSARY_LEAD}`}
      sections={sections}
      features={features}
    />
  );
}
