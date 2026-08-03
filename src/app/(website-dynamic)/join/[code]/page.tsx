import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { clubIdentity } from "@/config/club-identity";
import { auth } from "@/lib/auth";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { GroupJoinPageClient } from "@/app/(website-dynamic)/join/[code]/group-join-page-client";
import { MemberGroupJoinPanel } from "@/app/(website-dynamic)/join/[code]/member-group-join-panel";

export const metadata: Metadata = {
  title: "Join a group booking",
  robots: { index: false, follow: false },
};

/**
 * Permanently per-request (#2352): this page branches on `auth()` to show a member
 * the join panel, so it is dynamic already. The line is here because it is a
 * DYNAMIC SEGMENT, and a dynamic segment with no `generateStaticParams` that stops
 * reading the session would be generated on demand and then STORED — freezing one
 * visitor's view of a group-booking code for whoever asked next. Stating it removes
 * that possibility instead of relying on the `auth()` call staying put.
 *
 * Being in `(website-dynamic)` rather than `(website)` follows from the same fact
 * (owner decision, 3 Aug 2026): a page that is never stored gains nothing from the
 * fixed per-release CSP nonce, so it keeps the per-request one. The group's layout
 * declares the render mode as well; this line is the route's own reason.
 */
export const dynamic = "force-dynamic";

export default async function GroupJoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.groupBookings) {
    notFound();
  }
  const { code } = await params;
  // A logged-in member can add themselves and their family from their account;
  // everyone else uses the public (email-verified) non-member request form. The
  // branch is made HERE, server-side, rather than by wrapping the public site in a
  // client SessionProvider — neither public layout has one, and since #2352 slice 1
  // neither reads the session either, so this page's own `auth()` call is the only
  // place the distinction is drawn.
  const session = await auth();
  if (session?.user) {
    return <MemberGroupJoinPanel code={code} />;
  }
  return <GroupJoinPageClient club={clubIdentity} code={code} />;
}
