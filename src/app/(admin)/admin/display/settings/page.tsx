import { redirect } from "next/navigation";

// LTV-035 (#81): the per-lodge display settings (config glob, name granularity,
// committee notice) relocated into the lodge configuration hub
// (/admin/lodges/[id]) so they edit the lodge being viewed rather than always
// the club default lodge (old backlog #64). This path now permanently redirects
// to the Display Devices page so old bookmarks / links keep working; a pointer
// on that page directs admins to the new per-lodge home. Devices is the closest
// surviving Lobby Display surface (the lodge list is multiLodge-gated, so it is
// not a reliable landing spot).
export default function AdminDisplaySettingsRedirect() {
  redirect("/admin/display");
}
