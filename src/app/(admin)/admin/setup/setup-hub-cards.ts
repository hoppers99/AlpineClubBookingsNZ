import {
  BadgeCheck,
  Bell,
  BookOpenCheck,
  Landmark,
  ListChecks,
  Plug,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import type {
  AdminPermissionArea,
  AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import type { SetupStepId } from "@/lib/setup-step-registry";

/**
 * The setup hub cards — the legacy setup surface's own front door (epic #213,
 * child C8, #223).
 *
 * Lifted out of `setup-page-client.tsx`, where the list was a bare hardcoded
 * array, for one reason: C8's first acceptance criterion is that the cards, the
 * hub pages and the wizard cannot report different outstanding work, and a list
 * that lives inside a `"use client"` component can only be checked by rendering
 * it. Here a contract test reads the declarations directly
 * (`setup-surface-registry-parity.test.ts`).
 *
 * ## `coversStepIds` — what makes a card registry-derived
 *
 * Each card names the registry steps whose work is actually done through the
 * destination it opens. A card that names any is shown only while at least ONE
 * of them is still applicable to this club, so epic #213 **D4** reaches the hub
 * cards too: switch Xero and the finance dashboard off and the Finance hub card
 * goes with their steps, rather than offering a drill-down whose page then
 * explains that nothing in it is available. That was the visible disagreement
 * C8 exists to remove — the cards claiming there was finance setup to do while
 * the registry and the wizard both said there was none.
 *
 * ## `coversStepIds: []` is a DECLARATION, not an omission
 *
 * Two destinations here expose real capabilities that no registry step
 * describes — membership configuration and notification rules are ordinary
 * admin surfaces, not first-install readiness checks. An empty list means
 * "always shown, governed only by modules and permissions", and each one says
 * why below. The alternative (hiding a card with nothing applicable) would
 * delete two working surfaces the moment this file was written, which is the
 * opposite of what this issue asks for: hide, never remove.
 *
 * ## The parity contract
 *
 * `SetupStepId` is a literal union derived from the registry, so a renamed or
 * deleted step turns every stale reference here into a TYPECHECK error rather
 * than a card that quietly never appears. The other direction — a NEW step that
 * no hub card covers — the type system cannot see, so the contract test carries
 * it: every registry id must be covered here or named in that test's documented
 * exception list, which is what makes "which surface does an operator use for
 * this?" a decision somebody takes rather than one that happens by default.
 */
export interface SetupHubCard {
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly requiredAreas: readonly AdminPermissionArea[];
  /**
   * The registry steps this destination is where you do. Empty means the card
   * covers no readiness step at all and is therefore never hidden by
   * applicability — see the module doc.
   */
  readonly coversStepIds: readonly SetupStepId[];
}

export const SETUP_HUB_CARDS: readonly SetupHubCard[] = [
  {
    href: "/admin/setup/foundations",
    title: "Initial Setup",
    description:
      "Start with the installation checklist, club identity, modules, lodge records, and system health.",
    icon: ListChecks,
    requiredAreas: ["support"],
    // Every `core` foundation step. This card can never be hidden by
    // applicability in practice — `core` steps have no owning module to switch
    // off — and that is correct rather than redundant: the Modules page itself
    // (`feature-flags`) is reached through here, so a club that could hide this
    // card would have hidden the only route back to the toggles.
    coversStepIds: [
      "club-config",
      "club-time-zone",
      "environment-role",
      "runtime-env",
      "auth-secret-strength",
      "seed-admin",
      "feature-flags",
      "lodges",
    ],
  },
  {
    href: "/admin/setup/finance",
    title: "Finance",
    description:
      "Open finance reporting, Xero setup, sync tools, and the collapsed report-mapping editor.",
    icon: Landmark,
    requiredAreas: ["finance"],
    // The three module-owned steps this hub's own links lead to. With
    // xeroIntegration and financeDashboard both off — the first-install default
    // — none is applicable and the card is gone.
    coversStepIds: ["xero-operational", "finance-dashboard", "xero-mappings"],
  },
  {
    href: "/admin/setup/booking-rules",
    title: "Booking Rules",
    description:
      "Review booking policy, seasons, age groups, promo codes, inventory, and booking copy.",
    icon: BookOpenCheck,
    requiredAreas: ["bookings", "lodge"],
    coversStepIds: ["booking-policies", "age-tiers", "seasons-rates"],
  },
  {
    href: "/admin/setup/integrations",
    title: "Operational Integrations",
    description:
      "Check external-provider readiness, Xero connection, modules, and delivery health.",
    icon: Plug,
    requiredAreas: ["support", "finance"],
    // `xero-operational` is claimed by this card AND by Finance above, on
    // purpose: the Xero connection is genuinely reachable from both hubs, and
    // the parity test asserts coverage, never exclusivity. `stripe`,
    // `email-ses` and `sentry` are `core`, so this card survives any module
    // configuration.
    coversStepIds: [
      "stripe",
      "email-ses",
      "sentry",
      "address-autocomplete",
      "xero-operational",
    ],
  },
  {
    href: "/admin/membership-setup",
    title: "Membership & Members",
    description:
      "Configure membership types, member fields, and subscription lockout policy.",
    icon: BadgeCheck,
    requiredAreas: ["membership"],
    // No registry step: membership types, member fields and lockout policy are
    // ongoing club configuration rather than first-install readiness, and the
    // wizard does not walk them. Always shown.
    coversStepIds: [],
  },
  {
    href: "/admin/setup/cancellation",
    title: "Cancellation",
    description:
      "Review cancellation settings, cancellation request queues, and related message copy.",
    icon: UserX,
    requiredAreas: ["membership", "support"],
    coversStepIds: ["membership-cancellation"],
  },
  {
    href: "/admin/notifications",
    title: "Email Messages / Notifications",
    description:
      "Manage delivery rules, recipients, email templates, and member-facing message text.",
    icon: Bell,
    requiredAreas: ["support"],
    // No registry step. `email-ses` is the DELIVERY TRANSPORT check and its
    // work is done in the environment, not here; this destination is the
    // message copy and the recipient rules, which have no readiness check and
    // no wizard step. Always shown.
    coversStepIds: [],
  },
];

function canSeeAnyRequiredArea(
  permissionMatrix: AdminPermissionMatrix,
  areas: readonly AdminPermissionArea[],
) {
  return areas.some((area) => permissionMatrix[area] !== "none");
}

/**
 * Which hub cards this club is offered (epic #213, C8 #223).
 *
 * THREE INDEPENDENT GATES, and the third is the new one. Modules
 * (`isFeatureHrefVisible`) and permissions are unchanged.
 * `applicableStepIds` is the registry's applicable set, handed in as the ids of
 * the readiness checks the SERVER built — the same derivation the wizard rail
 * is drawn from, never a second one computed at the call site — so a hub whose
 * every covered step belongs to a disabled module is not offered at all.
 *
 * A card covering no step is never hidden by this gate; see the module doc for
 * why two of them legitimately cover none.
 *
 * Lives here rather than in `setup-page-client.tsx` so the contract test can
 * exercise it as a pure function, without a DOM and without pulling a
 * `"use client"` module into a node-environment test.
 */
export function getVisibleSetupHubCards(
  cards: readonly SetupHubCard[],
  features: FeatureFlags,
  permissionMatrix: AdminPermissionMatrix,
  applicableStepIds: ReadonlySet<string>,
): readonly SetupHubCard[] {
  return cards.filter(
    (card) =>
      isFeatureHrefVisible(card.href, features) &&
      canSeeAnyRequiredArea(permissionMatrix, card.requiredAreas) &&
      (card.coversStepIds.length === 0 ||
        card.coversStepIds.some((id) => applicableStepIds.has(id))),
  );
}
