import { SiteContentPanel } from "@/components/admin/site-content-panel";

export default function SiteContentAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Site Content</h1>
        <p className="mt-1 text-sm text-slate-500">
          Edit the shared site chrome shown on every public page. The footer
          columns below render exactly as written (after sanitising); the
          logo, copyright line, and privacy/terms links stay managed by the
          system.
        </p>
      </div>

      <SiteContentPanel />
    </div>
  );
}
