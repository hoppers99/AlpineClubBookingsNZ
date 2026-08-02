import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { clubIdentity } from "@/config/club-identity";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { GroupJoinVerifyPageClient } from "@/app/(website)/join/verify/[token]/group-join-verify-page-client";

export const metadata: Metadata = {
  title: "Confirm your group booking spot",
  robots: { index: false, follow: false },
};

/**
 * Permanently per-request (#2352), and this route is the reason the rule is stated
 * on every non-CMS `(website)` page rather than only the four D4 holds. It is a
 * dynamic segment carrying a ONE-TIME token in the URL and it reads no session, so
 * once the shared layout stopped reading the request there was nothing left to make
 * it dynamic: Next would have generated it on demand and stored it, and a
 * consumed-token page would then be served from the cache instead of re-checked.
 */
export const dynamic = "force-dynamic";

export default async function GroupJoinVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.groupBookings) {
    notFound();
  }
  const { token } = await params;
  return <GroupJoinVerifyPageClient club={clubIdentity} token={token} />;
}
