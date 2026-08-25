import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadSetupSurfaceSettings } from "@/lib/setup-surface-settings";
import { SetupPageClient } from "./setup-page-client";
import { loadAdminSetupPermissionMatrix } from "./permission-matrix";

// Thin server wrapper. The Setup page (support area) embeds cross-area cards —
// currently LodgeCapacityCard (lodge) plus drill-down links into finance,
// membership, bookings, and content — whose backing routes enforce different
// areas than this route. The matrix is computed server-side because
// definition-backed roles live in the DB and cannot be resolved client-side
// (same reason the layout precomputes it for the sidebar).
//
// `legacySurfacesHidden` (epic #213, C8 #223) is read here rather than fetched
// by the client so the page never renders the readiness cards and hub cards for
// a frame before hiding them. It is the INITIAL value only: the settings section
// hands the saved answer back to the client, which updates in place, so an
// operator sees the cards appear or disappear the moment they save rather than
// after a reload.
export default async function SetupPage() {
  const [permissionMatrix, features, surfaceSettings] = await Promise.all([
    loadAdminSetupPermissionMatrix(),
    loadEffectiveModuleFlags(),
    loadSetupSurfaceSettings(),
  ]);

  return (
    <SetupPageClient
      permissionMatrix={permissionMatrix}
      features={features}
      legacySurfacesHidden={surfaceSettings.legacySurfacesHidden}
    />
  );
}
