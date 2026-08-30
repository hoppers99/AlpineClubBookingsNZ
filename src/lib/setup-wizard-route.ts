/**
 * The setup wizard's canonical href (epic #213, C10, #236 fix round).
 *
 * Split out of `setup-nudge.ts` on purpose: that module imports `@/lib/prisma`,
 * and `setup-page-client.tsx` (the Setup page's own "Open the setup wizard"
 * button, `"use client"`) needs the SAME href without dragging the database
 * client into the browser bundle. A value import of `SETUP_WIZARD_HREF` from
 * `setup-nudge.ts` would do exactly that — `client-server-boundary-census.test.ts`
 * walks the real (non-`import type`) import graph from every `"use client"`
 * module and fails on the shortest path to a forbidden leaf, and `prisma` is
 * one of them. This file has zero imports, so it can never be that path.
 *
 * `setup-nudge.ts` re-exports this constant so the admin layout's existing
 * import keeps working unchanged.
 */
export const SETUP_WIZARD_HREF = "/admin/setup/wizard";
