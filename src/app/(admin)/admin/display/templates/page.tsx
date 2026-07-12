import { redirect } from "next/navigation";

// LTV-031: the per-lodge display settings card moved to /admin/display/settings
// so the /admin/display/templates path is free for LTV-033's Template authoring
// UI. This route now permanently redirects to the settings page; the sidebar
// links straight to /admin/display/settings.
export default function AdminDisplayTemplatesRedirect() {
  redirect("/admin/display/settings");
}
