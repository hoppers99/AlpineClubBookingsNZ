"use client";

import { BackLink } from "@/components/admin/back-link";
import { NoticeEditor } from "@/components/admin/notice-editor";

export default function NewNoticePage() {
  return (
    <div className="space-y-4">
      <BackLink href="/admin/notices" label="Member notices" />
      <NoticeEditor mode="create" />
    </div>
  );
}
