import { loadAdminSetupPermissionMatrix } from "../permission-matrix";
import { SetupWizardClient } from "./setup-wizard-client";

/**
 * The setup wizard (epic #213, child C5), at `/admin/setup/wizard`.
 *
 * Thin server wrapper, for the same reason `/admin/setup` has one: the
 * per-area permission matrix is definition-backed (roles live in the database)
 * and cannot be resolved client-side, and epic decision **D12** gates each
 * step's edit controls on the area that owns it.
 *
 * ADMISSION is unchanged from the readiness page: `/admin/setup/wizard` matches
 * the `/admin/setup` prefix in `ROUTE_AREA_PREFIXES`, so the admin layout admits
 * exactly the officers `/admin/setup` admits (support area). D12 replaced this
 * child's original "full administrator only" criterion — an officer reaches the
 * journey and works their own area's steps; everything else renders read-only.
 */
export default async function SetupWizardPage() {
  const permissionMatrix = await loadAdminSetupPermissionMatrix();

  return <SetupWizardClient permissionMatrix={permissionMatrix} />;
}
