import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { clubIdentity } from "@/config/club-identity";
import { auth } from "@/lib/auth";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { GroupJoinPageClient } from "@/app/(website)/join/[code]/group-join-page-client";
import { MemberGroupJoinPanel } from "@/app/(website)/join/[code]/member-group-join-panel";

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
  // (website) layout already reads auth() server-side, so we branch here rather
  // than wrapping the public site in a client SessionProvider.
  const session = await auth();
  if (session?.user) {
    return <MemberGroupJoinPanel code={code} />;
  }
  return <GroupJoinPageClient club={clubIdentity} code={code} />;
}
