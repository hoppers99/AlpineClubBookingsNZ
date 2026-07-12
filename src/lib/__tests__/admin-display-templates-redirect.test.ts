import { describe, expect, it, vi } from "vitest";

// LTV-031: the per-lodge display settings card moved from
// /admin/display/templates to /admin/display/settings so the `templates` path
// is free for LTV-033's Template authoring UI. The old path must permanently
// redirect to the new one so existing links / bookmarks keep working.

const { mockRedirect } = vi.hoisted(() => ({ mockRedirect: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

describe("/admin/display/templates redirect (LTV-031)", () => {
  it("redirects to /admin/display/settings", async () => {
    const { default: AdminDisplayTemplatesRedirect } = await import(
      "@/app/(admin)/admin/display/templates/page"
    );
    AdminDisplayTemplatesRedirect();
    expect(mockRedirect).toHaveBeenCalledWith("/admin/display/settings");
  });
});
