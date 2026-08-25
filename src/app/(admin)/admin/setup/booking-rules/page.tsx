import { redirect } from "next/navigation";
import {
  BedDouble,
  CalendarRange,
  MessageSquareText,
  Sliders,
  Tag,
  XCircle,
} from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  areLegacySetupSurfacesHidden,
  loadSetupSurfaceSettings,
} from "@/lib/setup-surface-settings";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";

const sections: AdminHubSection[] = [
  {
    href: "/admin/booking-policies",
    title: "Booking Policies",
    description:
      "Configure cancellation, minimum-stay, public-request, and group-discount rules.",
    icon: XCircle,
  },
  {
    href: "/admin/seasons",
    title: "Hut Fees & Seasons",
    description:
      "Maintain season windows and member/non-member nightly rates.",
    icon: CalendarRange,
  },
  {
    href: "/admin/age-tier-settings",
    title: "Age Groups",
    description:
      "Set age-tier boundaries and whether each tier needs a subscription to book.",
    icon: Sliders,
  },
  {
    href: "/admin/promo-codes",
    title: "Promo Codes",
    description:
      "Manage booking discounts and promotional code eligibility.",
    icon: Tag,
  },
  {
    href: "/admin/rooms-beds",
    title: "Rooms & Beds",
    description:
      "Configure lodge room and bed inventory used by capacity and allocation workflows.",
    icon: BedDouble,
  },
  {
    href: "/admin/booking-messages",
    title: "Booking Messages",
    description:
      "Edit booking, payment, cancellation, and group-booking copy.",
    icon: MessageSquareText,
  },
];

export default async function BookingRulesSetupHubPage() {
  /*
    Epic #213 D8, C8 (#223). HIDDEN MEANS ABSENT, NOT DELETED — this issue's
    "hide, don't remove" is explicit — so the route still exists and answers,
    and it answers by sending the operator to the surface that replaced it. A
    404 was the other candidate and is the wrong shape here: 404 is what a
    DISABLED MODULE's route returns (`getFeatureFlagBlockResponse` in
    `src/proxy.ts`), because that surface has no successor and the module state
    is something the answer must not leak. This surface has a successor — every
    destination on this hub is a step of the wizard — and its state is a club
    preference an admin can read on the page they land on.

    The redirect target is `/admin/setup`, which stays reachable in BOTH
    positions and carries the switch: an operator who followed a stale bookmark
    lands where they can see why, and where they can put it back.

    Checked here rather than in the proxy on purpose. A proxy gate would put a
    settings read on the hot path for every request that matches the prefix,
    including the wizard's own; this is one query on four rarely-visited pages.
  */
  if (areLegacySetupSurfacesHidden(await loadSetupSurfaceSettings())) {
    redirect("/admin/setup");
  }
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <AdminHubPage
      title="Booking Rules"
      description="Review the setup pages that shape booking eligibility, pricing, capacity, and member-facing booking copy."
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
      backHref="/admin/setup"
      backLabel="Setup checklist"
    />
  );
}
