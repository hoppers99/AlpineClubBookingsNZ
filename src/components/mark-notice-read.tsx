"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Records a read receipt for a notice when the member actually views the detail
 * page. This runs in a useEffect on mount — NEVER a server-render side effect —
 * so a Next.js Link prefetch (which renders the page on the server without the
 * member navigating) can never forge a read.
 *
 * On success it refreshes the route so server components (dashboard unread
 * badge, list bolding) reflect the new read state on the next navigation.
 */
export function MarkNoticeRead({
  noticeId,
  alreadyRead,
}: {
  noticeId: string;
  alreadyRead: boolean;
}) {
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    if (alreadyRead || firedRef.current) {
      return;
    }
    firedRef.current = true;

    let cancelled = false;
    void fetch(`/api/notices/${noticeId}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
      .then((res) => {
        if (!cancelled && res.ok) {
          router.refresh();
        }
      })
      .catch(() => {
        // Best-effort; a failed read receipt is non-critical.
      });

    return () => {
      cancelled = true;
    };
  }, [noticeId, alreadyRead, router]);

  return null;
}
