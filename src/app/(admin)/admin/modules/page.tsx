import { ModulesSection } from "./modules-section";

/**
 * `/admin/modules` — the shell around {@link ModulesSection} (epic #213, child
 * C13, #239).
 *
 * The editor itself used to BE this file. C13 lifted it into a zero-prop
 * section so the setup wizard can mount the same controls inline on its
 * `feature-flags` and `address-autocomplete` steps, where switching a module on
 * or off redraws the rail beside the checkbox that did it (D5). This is the
 * shape `/admin/appearance/identity` already uses for `ClubIdentityPanel`: the
 * page owns the screen's heading and the section owns everything with state.
 *
 * The shell needs no `"use client"` of its own, and the exemplar does not have
 * one either: every stateful thing on this screen is inside the section, which
 * declares the boundary itself. The page is static JSX around it.
 */
export default function AdminModulesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Modules</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Turn optional club modules on or off. These toggles are the single
          control for whether a module is available across the site.
        </p>
      </div>

      <ModulesSection />
    </div>
  );
}
