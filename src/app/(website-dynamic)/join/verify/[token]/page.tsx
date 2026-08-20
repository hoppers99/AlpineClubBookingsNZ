import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { clubIdentity } from "@/config/club-identity";
import { resolveGroupJoinVerificationLodgeName } from "@/lib/group-booking";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { GroupJoinVerifyPageClient } from "@/app/(website-dynamic)/join/verify/[token]/group-join-verify-page-client";

export const metadata: Metadata = {
  title: "Confirm your group booking spot",
  robots: { index: false, follow: false },
};

/**
 * Permanently per-request (#2352), and this route is the reason the rule is stated
 * on every public page rather than only the four D4 holds. It is a dynamic segment
 * carrying a ONE-TIME token in the URL and it reads no session, so once the shared
 * layout stopped reading the request there was nothing left to make it dynamic:
 * Next would have generated it on demand and stored it, and a consumed-token page
 * would then be served from the cache instead of re-checked.
 *
 * A one-time token in the URL is also why this route sits in `(website-dynamic)`
 * (owner decision, 3 Aug 2026): it is never stored, so the fixed per-release CSP
 * nonce would buy it nothing, and it keeps the per-request nonce instead. The
 * group's layout declares the render mode as well; this line is the route's own
 * reason.
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
  // #2919: the "finalise your spot at ..." copy renders BEFORE the joiner
  // clicks Confirm, so the (mutating, POST-only) verify endpoint cannot supply
  // the lodge. Resolve it here instead; null falls back to the club default.
  const lodgeName = await resolveGroupJoinVerificationLodgeName(token);
  return (
    <GroupJoinVerifyPageClient
      club={clubIdentity}
      token={token}
      lodgeName={lodgeName}
    />
  );
}
